import { existsSync, writeFileSync } from "node:fs";
import {
  fetchOtherProviders,
  getAntigravitySignIns,
  getClaudeSignIns,
  getCodexSignIns,
  resolveBinary,
} from "./providers.ts";

export const CACHE_FILE = "/tmp/herdr-usage-cache.json";
export const AGY_CACHE_FILE = "/tmp/herdr-agy-usage.json";

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
  claude?: DetailedClaude | null;
  codex?: DetailedCodex | null;
  antigravity?: DetailedAgy | null;
  others: GenericProvider[];
}

export async function getCachedReport(maxAgeMs = 180_000): Promise<FullReport | null> {
  try {
    const file = Bun.file(CACHE_FILE);
    if (await file.exists()) {
      const data = JSON.parse(await file.text()) as FullReport;
      if (Date.now() - (data.timestamp || 0) < maxAgeMs) {
        return data;
      }
    }
  } catch {}
  return null;
}

export function saveCachedReport(report: FullReport): void {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(report));
  } catch {}
}

export async function fetchDetailedReport(options?: { fast?: boolean }): Promise<FullReport> {
  const fast = options?.fast === true;
  const timeoutMs = fast ? 1400 : 3500;

  const [claudeSignIns, codexSignIns, agySignIns] = await Promise.all([
    getClaudeSignIns().catch(() => []),
    getCodexSignIns().catch(() => []),
    getAntigravitySignIns().catch(() => []),
  ]);

  const report: FullReport = { timestamp: Date.now(), others: [] };

  // Fetch Claude
  const claudePromise = (async () => {
    const s = claudeSignIns[0];
    if (!s) return;
    const res = await fetch("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", {
      headers: {
        authorization: `Bearer ${s.token}`,
        accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.1.0 (external, cli)",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return;
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
    const s = codexSignIns[0];
    if (!s) return;
    const headers: Record<string, string> = {
      authorization: `Bearer ${s.token}`,
      accept: "application/json",
      ...(s.chatgptAccount ? { "chatgpt-account-id": s.chatgptAccount } : {}),
    };
    const [usageRes, creditsRes] = await Promise.all([
      fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      }),
      fast
        ? Promise.resolve(null)
        : fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
            headers,
            signal: AbortSignal.timeout(timeoutMs),
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
    const s = agySignIns[0];
    const account = s?.account?.label ?? "default";

    // Try reading recent agy cache
    let agyData: any = null;
    try {
      if (existsSync(AGY_CACHE_FILE)) {
        const stat = await Bun.file(AGY_CACHE_FILE).stat();
        if (Date.now() - stat.mtimeMs < 120_000) {
          agyData = JSON.parse(await Bun.file(AGY_CACHE_FILE).text());
        }
      }
    } catch {}

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
    const init = {
      method: "POST",
      headers: {
        authorization: `Bearer ${s.token}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "antigravity",
      },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    };
    let res = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init).catch(() => null);
    if (!res || !res.ok) {
      res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init).catch(() => null);
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
  const othersPromise = fetchOtherProviders({ fast })
    .then((others) => {
      report.others = others;
    })
    .catch(() => {});

  await Promise.all([claudePromise, codexPromise, agyPromise, othersPromise]);

  // Fallback to previous disk cache if a provider was rate limited or temporarily unreachable
  try {
    const prev = await getCachedReport(24 * 3600_000);
    if (prev) {
      if (!report.claude && prev.claude) report.claude = prev.claude;
      if (!report.codex && prev.codex) report.codex = prev.codex;
      if (!report.antigravity && prev.antigravity) report.antigravity = prev.antigravity;
      if (report.others.length === 0 && prev.others?.length) report.others = prev.others;
    }
  } catch {}

  saveCachedReport(report);
  return report;
}
