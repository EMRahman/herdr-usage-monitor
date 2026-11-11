import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type DiscoveryOptions,
  fetchOtherProviders,
  getAntigravitySignIns,
  getClaudeSignIns,
  getCodexSignIns,
  resolveBinary,
} from "./providers.ts";

export const CACHE_DIR =
  process.env["HERDR_USAGE_CACHE_DIR"] ??
  (process.env["XDG_CACHE_HOME"]
    ? join(process.env["XDG_CACHE_HOME"], "herdr-usage-monitor")
    : join(homedir(), ".cache", "herdr-usage-monitor"));

export const CACHE_FILE = join(CACHE_DIR, "herdr-usage-cache.json");
export const FAST_CACHE_FILE = join(CACHE_DIR, "herdr-usage-fast-cache.json");
export const AGY_CACHE_FILE = join(CACHE_DIR, "herdr-agy-usage.json");
export const RATE_LIMITS_FILE = join(CACHE_DIR, "rate-limits.json");

const FAST_TOTAL_BUDGET_MS = 1_600;

export interface CodexCreditItem {
  id: string;
  title: string;
  status: string;
  granted_at: string;
  expires_at: string;
  description?: string;
}

export interface DetailedCodex {
  account: string;
  plan: string;
  windows: Array<{ label: string; used_percent: number; resets_at: string | null }>;
  resets: {
    available: number;
    items: CodexCreditItem[];
  };
}

export interface DetailedClaude {
  account: string;
  plan: string;
  windows: Array<{ label: string; used_percent: number; resets_at: string | null }>;
  extra_usage?: {
    used: string;
    limit: string;
    balance_left?: string;
    used_percent: number;
  } | null;
}

export interface AgyBucket {
  label: string;
  remaining_percent: number;
  resets_at: string | null;
  description?: string;
}

export interface DetailedAgy {
  account: string;
  tier?: string;
  groups: Array<{
    name: string;
    models?: string;
    buckets: AgyBucket[];
  }>;
}

export interface GenericProvider {
  id: string;
  account: string;
  plan: string | null;
  windows: Array<{ kind: string; scope: string | null; used_percent: number; resets_at: string | null }>;
  credits?: { label: string | null; balance: string | null; used_percent?: number | null } | null;
  resets?: { available: number; expires_at: string | null } | null;
  problem: string | null;
}

export interface FullReport {
  timestamp: number;
  /** True when produced by fast tab-bar mode (omits secondary breakdown calls). */
  partial?: boolean;
  claude?: DetailedClaude | null;
  codex?: DetailedCodex | null;
  antigravity?: DetailedAgy | null;
  others: GenericProvider[];
}

interface RateLimitState {
  claudeUntil?: number;
}

async function getRateLimitsAsync(): Promise<RateLimitState> {
  try {
    const file = Bun.file(RATE_LIMITS_FILE);
    if (await file.exists()) {
      return JSON.parse(await file.text()) as RateLimitState;
    }
  } catch {}
  return {};
}

function saveRateLimits(state: RateLimitState): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(RATE_LIMITS_FILE, JSON.stringify(state));
  } catch {}
}

async function readCacheFile(path: string, maxAgeMs: number): Promise<FullReport | null> {
  try {
    let file = Bun.file(path);
    if (!(await file.exists())) {
      const legacyPath = join("/tmp", basename(path));
      const legacyFile = Bun.file(legacyPath);
      if (await legacyFile.exists()) {
        file = legacyFile;
      }
    }
    if (await file.exists()) {
      const data = JSON.parse(await file.text()) as FullReport;
      if (Date.now() - (data.timestamp || 0) < maxAgeMs) {
        return data;
      }
    }
  } catch {}
  return null;
}

export async function getCachedReport(
  maxAgeMs = 300_000,
  options?: { allowFast?: boolean },
): Promise<FullReport | null> {
  const complete = await readCacheFile(CACHE_FILE, maxAgeMs);
  if (!options?.allowFast) {
    return complete && !complete.partial ? complete : null;
  }
  const fast = await readCacheFile(FAST_CACHE_FILE, maxAgeMs);
  if (complete && fast) {
    return (complete.timestamp || 0) >= (fast.timestamp || 0) ? complete : fast;
  }
  return complete ?? fast;
}

export function saveCachedReport(report: FullReport): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(report.partial ? FAST_CACHE_FILE : CACHE_FILE, JSON.stringify(report));
  } catch {}
}

function remainingBudget(deadlineMs: number | undefined, defaultMs: number, fastCapMs: number): number {
  const cap = deadlineMs !== undefined ? Math.min(defaultMs, fastCapMs) : defaultMs;
  if (deadlineMs === undefined) return cap;
  return Math.max(0, Math.min(cap, deadlineMs - Date.now()));
}

export async function fetchDetailedReport(options?: { fast?: boolean }): Promise<FullReport> {
  const fast = options?.fast === true;
  const deadlineMs = fast ? Date.now() + FAST_TOTAL_BUDGET_MS : undefined;
  const discoveryOpts: DiscoveryOptions = { fast, deadlineMs };

  const report: FullReport = {
    timestamp: Date.now(),
    ...(fast ? { partial: true } : {}),
    others: [],
  };

  // Fetch Claude (discovers its own credentials so slow Keychain never blocks other providers)
  const claudePromise = (async () => {
    const limits = await getRateLimitsAsync();
    if (limits.claudeUntil && Date.now() < limits.claudeUntil) {
      return;
    }

    const claudeSignIns = await getClaudeSignIns(discoveryOpts).catch(() => []);
    const s = claudeSignIns[0];
    if (!s) return;
    const reqTimeout = remainingBudget(deadlineMs, 3500, 1200);
    if (reqTimeout <= 50) return;
    const res = await fetch("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", {
      headers: {
        authorization: `Bearer ${s.token}`,
        accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.1.0 (external, cli)",
      },
      signal: AbortSignal.timeout(reqTimeout),
    }).catch(() => null);

    if (!res) return;

    if (res.status === 429) {
      const retryHeader = res.headers.get("retry-after");
      const retrySec = retryHeader ? parseInt(retryHeader, 10) : NaN;
      const cooldownMs = Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : 300_000;
      saveRateLimits({ ...limits, claudeUntil: Date.now() + cooldownMs });
      return;
    }

    if (!res.ok) return;

    if (limits.claudeUntil) {
      delete limits.claudeUntil;
      saveRateLimits(limits);
    }

    const body = (await res.json()) as any;

    const windows: DetailedClaude["windows"] = [];
    if (body.five_hour && body.five_hour.utilization != null) {
      windows.push({ label: "5h session", used_percent: body.five_hour.utilization, resets_at: body.five_hour.resets_at });
    }
    if (body.seven_day && body.seven_day.utilization != null) {
      windows.push({ label: "7d weekly", used_percent: body.seven_day.utilization, resets_at: body.seven_day.resets_at });
    }
    if (body.seven_day_opus && body.seven_day_opus.utilization != null) {
      windows.push({ label: "7d Opus", used_percent: body.seven_day_opus.utilization, resets_at: body.seven_day_opus.resets_at });
    }
    if (body.seven_day_sonnet && body.seven_day_sonnet.utilization != null) {
      windows.push({ label: "7d Sonnet", used_percent: body.seven_day_sonnet.utilization, resets_at: body.seven_day_sonnet.resets_at });
    }

    let extra_usage = null;
    if (body.extra_usage?.is_enabled || body.spend?.enabled) {
      const currency = body.extra_usage?.currency ?? body.spend?.used?.currency ?? "USD";
      const curr = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency} `;
      const decimals = body.extra_usage?.decimal_places ?? 2;
      const divisor = Math.pow(10, decimals);
      const usedMinor = body.spend?.used?.amount_minor ?? body.extra_usage?.used_credits ?? 0;
      const limitMinor = body.spend?.limit?.amount_minor ?? body.extra_usage?.monthly_limit ?? 0;
      const usedStr = `${curr}${(usedMinor / divisor).toFixed(decimals)}`;
      const limitStr = `${curr}${(limitMinor / divisor).toFixed(decimals)}`;
      const leftStr = `${curr}${Math.max(0, (limitMinor - usedMinor) / divisor).toFixed(decimals)}`;
      const usedPct = body.extra_usage?.utilization ?? body.spend?.percent ?? 0;
      extra_usage = {
        used: usedStr,
        limit: limitStr,
        balance_left: leftStr,
        used_percent: usedPct,
      };
    }

    report.claude = {
      account: s.account?.label ?? "default",
      plan: s.plan ?? "pro",
      windows,
      extra_usage,
    };
  })().catch(() => {});

  // Fetch Codex
  const codexPromise = (async () => {
    const codexSignIns = await getCodexSignIns(discoveryOpts).catch(() => []);
    const s = codexSignIns[0];
    if (!s) return;
    const reqTimeout = remainingBudget(deadlineMs, 3500, 1200);
    if (reqTimeout <= 50) return;
    const headers: Record<string, string> = {
      authorization: `Bearer ${s.token}`,
      accept: "application/json",
      ...(s.chatgptAccount ? { "chatgpt-account-id": s.chatgptAccount } : {}),
    };
    const [usageRes, creditsRes] = await Promise.all([
      fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers,
        signal: AbortSignal.timeout(reqTimeout),
      }),
      fast
        ? Promise.resolve(null)
        : fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
            headers,
            signal: AbortSignal.timeout(reqTimeout),
          }).catch(() => null),
    ]);
    if (!usageRes.ok) return;
    const body = (await usageRes.json()) as any;
    const creditsBody = creditsRes && creditsRes.ok ? ((await creditsRes.json()) as any) : null;

    const rate = body.rate_limit ?? {};
    const windows: DetailedCodex["windows"] = [];
    if (rate.primary_window && rate.primary_window.used_percent != null) {
      const resetIso = rate.primary_window.reset_at ? new Date(rate.primary_window.reset_at * 1000).toISOString() : null;
      windows.push({ label: "5h session", used_percent: rate.primary_window.used_percent, resets_at: resetIso });
    }
    if (rate.secondary_window && rate.secondary_window.used_percent != null) {
      const resetIso = rate.secondary_window.reset_at ? new Date(rate.secondary_window.reset_at * 1000).toISOString() : null;
      windows.push({ label: "Weekly", used_percent: rate.secondary_window.used_percent, resets_at: resetIso });
    }

    const availableResets = body.rate_limit_reset_credits?.available_count ?? 0;
    const rawCredits = Array.isArray(creditsBody?.credits) ? creditsBody.credits : [];
    const items: CodexCreditItem[] = rawCredits
      .filter((c: any) => c.status === "available")
      .map((c: any) => ({
        id: c.id,
        title: c.title ?? "Rate limit reset",
        status: c.status,
        granted_at: c.granted_at,
        expires_at: c.expires_at,
        description: c.description,
      }))
      .sort((a: any, b: any) => Date.parse(a.expires_at) - Date.parse(b.expires_at));

    report.codex = {
      account: s.account?.label ?? body.email ?? "default",
      plan: s.plan ?? body.plan_type ?? "plus",
      windows,
      resets: {
        available: availableResets,
        items,
      },
    };
  })().catch(() => {});

  // Fetch Antigravity (AGY)
  const agyPromise = (async () => {
    // Try reading recent agy cache first before touching Keychain
    let agyData: any = null;
    try {
      let agyPath = AGY_CACHE_FILE;
      if (!existsSync(agyPath) && existsSync("/tmp/herdr-agy-usage.json")) {
        agyPath = "/tmp/herdr-agy-usage.json";
      }
      if (existsSync(agyPath)) {
        const stat = await Bun.file(agyPath).stat();
        if (Date.now() - stat.mtimeMs < 120_000) {
          agyData = JSON.parse(await Bun.file(agyPath).text());
        }
      }
    } catch {}

    const agySignIns = await getAntigravitySignIns(discoveryOpts).catch(() => []);
    const s = agySignIns[0];
    const account = s?.account?.label ?? "default";

    // If not cached (and not in fast cold-bar mode), invoke agy CLI
    if (!agyData && !fast) {
      const agyBin = resolveBinary("agy");
      if (agyBin) {
        try {
          const child = Bun.spawn([agyBin, "-p", "/usage", "--output-format", "json"], {
            stdout: "pipe",
            stderr: "ignore",
          });
          const timer = setTimeout(() => {
            try {
              child.kill();
            } catch {}
          }, 4500);
          const text = await new Response(child.stdout).text();
          clearTimeout(timer);
          if ((await child.exited) === 0 && text) {
            const parsed = JSON.parse(text);
            if (parsed.command?.data?.groups) {
              agyData = parsed.command.data;
              try {
                mkdirSync(CACHE_DIR, { recursive: true });
                writeFileSync(AGY_CACHE_FILE, JSON.stringify(agyData));
              } catch {}
            }
          }
        } catch {}
      }
    }

    if (agyData?.groups) {
      const groups = agyData.groups.map((g: any) => {
        const models = g.description?.startsWith("Models within this group:")
          ? g.description.replace(/^Models within this group:\s*/i, "")
          : undefined;
        const buckets: AgyBucket[] = (g.buckets ?? []).map((b: any) => {
          const remFraction = b.remaining_fraction ?? b.remainingFraction ?? 0;
          return {
            label: b.name ?? (b.window === "5h" ? "5h limit" : b.window === "weekly" ? "Weekly limit" : "Limit"),
            remaining_percent: Math.round(remFraction * 100),
            resets_at: b.reset_time ?? b.resetTime ?? null,
            description: b.description,
          };
        });
        return {
          name: g.name,
          models,
          buckets,
        };
      });

      report.antigravity = {
        account,
        groups,
      };
      return;
    }

    // Direct API fallback
    if (!s) return;
    const headers = {
      authorization: `Bearer ${s.token}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "antigravity",
    };
    const firstTimeout = remainingBudget(deadlineMs, 3000, 900);
    if (firstTimeout <= 50) return;
    let res = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(firstTimeout),
    }).catch(() => null);
    if (!res || !res.ok) {
      const retryTimeout = remainingBudget(deadlineMs, 3000, 900);
      if (retryTimeout > 50) {
        res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(retryTimeout),
        }).catch(() => null);
      }
    }
    if (!res || !res.ok) return;
    const body = (await res.json()) as any;
    const rawGroups = body.groups ?? body.response?.groups;
    const groupsRaw = Array.isArray(rawGroups) ? rawGroups : [];
    const groups = groupsRaw.map((g: any) => ({
      name: g.displayName ?? g.name ?? "Model group",
      models: g.description?.replace(/^Models within this group:\s*/i, "") ?? "",
      buckets: (g.buckets ?? []).map((b: any) => {
        const bucketId = String(b.bucketId ?? "");
        const is5h = b.window === "5h" || bucketId.endsWith("-5h");
        const isWeekly = b.window === "weekly" || bucketId.endsWith("-weekly");
        return {
          label: is5h ? "5h limit" : isWeekly ? "Weekly limit" : (b.displayName ?? b.name ?? "Limit"),
          remaining_percent: Math.round((b.remainingFraction ?? 0) * 100),
          resets_at: b.resetTime ?? null,
        };
      }),
    }));

    if (groups.length > 0) {
      report.antigravity = {
        account,
        groups,
      };
    }
  })().catch(() => {});

  // Secondary providers (Cursor, Copilot, Grok, OpenCode)
  const othersPromise = fetchOtherProviders(discoveryOpts)
    .then((others) => {
      report.others = others;
    })
    .catch(() => {});

  const allTasks = Promise.allSettled([claudePromise, codexPromise, agyPromise, othersPromise]);
  if (deadlineMs !== undefined) {
    await Promise.race([allTasks, Bun.sleep(Math.max(0, deadlineMs - Date.now()))]);
  } else {
    await allTasks;
  }

  // Merge preserved details and fallback providers from previous cache
  try {
    const prevComplete = await getCachedReport(24 * 3600_000);
    const prevAny = await getCachedReport(24 * 3600_000, { allowFast: true });

    if (!report.claude) {
      report.claude = prevAny?.claude ?? prevComplete?.claude;
    }
    if (!report.codex) {
      report.codex = prevComplete?.codex ?? prevAny?.codex;
    }
    if (!report.antigravity) {
      report.antigravity = prevComplete?.antigravity ?? prevAny?.antigravity;
    }
    if (report.others.length === 0) {
      if (prevComplete?.others?.length) report.others = prevComplete.others;
      else if (prevAny?.others?.length) report.others = prevAny.others;
    }

    // If Codex reset-credit details were skipped (or came from fast fallback), preserve cached items
    if (
      report.codex &&
      report.codex.resets.available > 0 &&
      report.codex.resets.items.length === 0 &&
      prevComplete?.codex?.account === report.codex.account &&
      prevComplete.codex.resets.items.length > 0
    ) {
      const now = Date.now();
      report.codex.resets.items = prevComplete.codex.resets.items
        .filter((item) => {
          const exp = Date.parse(item.expires_at);
          return !Number.isFinite(exp) || exp > now;
        })
        .slice(0, report.codex.resets.available);
    }
  } catch {}

  saveCachedReport(report);
  return report;
}
