import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  claudeCodeVersion,
  fetchOtherProviders,
  getAntigravitySignIns,
  getClaudeSignIns,
  getCodexSignIns,
  resolveBinary,
} from "./providers.ts";

const CACHE_DIR =
  process.env["HERDR_USAGE_CACHE_DIR"] ??
  (process.env["XDG_CACHE_HOME"]
    ? join(process.env["XDG_CACHE_HOME"], "herdr-usage-monitor")
    : join(homedir(), ".cache", "herdr-usage-monitor"));

const CACHE_FILE = join(CACHE_DIR, "herdr-usage-cache.json");
const LEGACY_PARTIAL_CACHE_FILE = join(CACHE_DIR, "herdr-usage-fast-cache.json");
const AGY_CACHE_FILE = join(CACHE_DIR, "herdr-agy-usage.json");
const RATE_LIMITS_FILE = join(CACHE_DIR, "rate-limits.json");

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

/** A limit reset Anthropic granted: using one refills the limits it clears at once. */
export interface ClaudeLimitReset {
  id: string;
  label: string;
  /** Resets of this grant still to use, and how many it came with. */
  left: number;
  total: number;
  /** The last moment it can be used. */
  expires_at: string | null;
  usable_now: boolean;
  paused: boolean;
  /** Only usable once a limit is reached, not at any time. */
  needs_limit: boolean;
}

/** Prepaid usage credits: the balance, and the parts of it that expire, soonest first. */
export interface ClaudeCredits {
  balance: string;
  expiring: Array<{ amount: string; expires_at: string; name?: string }>;
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
  limit_resets?: ClaudeLimitReset[];
  /** Missing when the balance couldn't be read; null when the account has no prepaid credits. */
  credits?: ClaudeCredits | null;
  /** When the credit balance was read (ms), whether or not there was one. */
  credits_read_at?: number;
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
  /** Older cached reports may omit parts of the breakdown. */
  partial?: boolean;
  claude?: DetailedClaude | null;
  codex?: DetailedCodex | null;
  antigravity?: DetailedAgy | null;
  others: GenericProvider[];
  /** When each provider's figures were read (ms), by id: claude, codex, antigravity, or another
   *  provider's id. Figures carried over from an older report keep that report's time; ones
   *  from a report without read_at have none. */
  read_at?: Record<string, number>;
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

// Antigravity quotes the Unix epoch (1970-01-01T00:00:00Z) as the reset of a limit with no
// window running, as it does for a model group that hasn't been used yet: that's no reset.
function agyReset(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? value : null;
}

// Amounts come in minor units ("839" GBP with 2 decimals is £8.39).
function money(minor: number, currency: string, decimals = 2): string {
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${(minor / Math.pow(10, decimals)).toFixed(decimals)}`;
}

const isoTime = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

/** The limit resets in Claude's usage answer (its cedar_ember block) still to use, soonest to
 *  expire first. Anthropic lists them only to a recent Claude Code version. */
export function claudeLimitResets(body: any, now = Date.now()): ClaudeLimitReset[] {
  const grants = Array.isArray(body?.cedar_ember?.grants) ? body.cedar_ember.grants : [];
  return grants
    .filter((g: any) => typeof g?.resets_left === "number" && g.resets_left > 0)
    .map((g: any): ClaudeLimitReset => ({
      id: String(g.id ?? ""),
      label: typeof g.label === "string" && g.label.trim() ? g.label.trim()
        : g.type === "full" ? "Full limit reset" : "Limit reset",
      left: g.resets_left,
      total: typeof g.resets_total === "number" ? Math.max(g.resets_total, g.resets_left) : g.resets_left,
      expires_at: isoTime(g.ends_at),
      usable_now: g.usable_now !== false,
      paused: g.paused === true,
      needs_limit: g.use_requires_limit === true,
    }))
    .filter((r: ClaudeLimitReset) => !r.expires_at || Date.parse(r.expires_at) > now)
    .sort((a: ClaudeLimitReset, b: ClaudeLimitReset) =>
      (a.expires_at ? Date.parse(a.expires_at) : Infinity) - (b.expires_at ? Date.parse(b.expires_at) : Infinity));
}

/** The prepaid credit balance from Claude's prepaid/credits answer, with the parts of it that
 *  expire (bought and promotional credit alike), or null when the account has none. */
export function claudeCredits(body: any, now = Date.now()): ClaudeCredits | null {
  if (typeof body?.amount !== "number") return null;
  const total = body.balance?.money;
  const currency = total?.currency ?? body.currency ?? "USD";
  const decimals = typeof total?.exponent === "number" ? total.exponent : 2;
  const amount = typeof total?.amount_minor === "number" ? total.amount_minor : body.amount;
  const tranches = [
    ...(Array.isArray(body.tranches) ? body.tranches : []),
    ...(Array.isArray(body.promo_tranches) ? body.promo_tranches : []),
  ];
  const expiring = tranches
    .map((t: any) => ({ t, expires: isoTime(t?.shown_expires_at) ?? isoTime(t?.expires_at) }))
    .filter(({ t, expires }) => typeof t?.remaining_amount_minor_units === "number"
      && t.remaining_amount_minor_units > 0 && expires && Date.parse(expires) > now)
    .sort((a, b) => Date.parse(a.expires!) - Date.parse(b.expires!))
    .map(({ t, expires }) => ({
      amount: money(t.remaining_amount_minor_units, t.currency ?? currency, decimals),
      expires_at: expires!,
      ...(typeof t.name === "string" && t.name.trim() ? { name: t.name.trim() } : {}),
    }));
  if (amount <= 0 && expiring.length === 0) return null;
  return { balance: money(amount, currency, decimals), expiring };
}

// The credit balance only moves once a limit is reached, so it's read less often than the limits.
const CREDITS_MAX_AGE_MS = 15 * 60_000;

type CreditsRead = { credits: ClaudeCredits | null; read_at: number };

/** The credit balance read last time for this account while it's recent, including a read that
 *  found none, so an account without credits isn't asked again on every refresh. */
export function recentCredits(
  previous: DetailedClaude | null | undefined,
  account: string,
  now = Date.now(),
): CreditsRead | undefined {
  if (previous?.account !== account || previous.credits === undefined) return undefined;
  const at = previous.credits_read_at;
  return typeof at === "number" && now - at < CREDITS_MAX_AGE_MS ? { credits: previous.credits, read_at: at } : undefined;
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
  options?: { allowPartial?: boolean },
): Promise<FullReport | null> {
  const complete = await readCacheFile(CACHE_FILE, maxAgeMs);
  if (!options?.allowPartial) {
    return complete && !complete.partial ? complete : null;
  }
  const partial = await readCacheFile(LEGACY_PARTIAL_CACHE_FILE, maxAgeMs);
  if (complete && partial) {
    return complete.timestamp >= partial.timestamp ? complete : partial;
  }
  return complete ?? partial;
}

function saveCachedReport(report: FullReport): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(report));
  } catch {}
}

export async function fetchDetailedReport(): Promise<FullReport> {
  const report: FullReport = {
    timestamp: Date.now(),
    others: [],
  };
  const readAt: Record<string, number> = {};

  // Fetch Claude (discovers its own credentials so slow Keychain never blocks other providers)
  const claudePromise = (async () => {
    const limits = await getRateLimitsAsync();
    if (limits.claudeUntil && Date.now() < limits.claudeUntil) {
      return;
    }

    const claudeSignIns = await getClaudeSignIns().catch(() => []);
    const s = claudeSignIns[0];
    if (!s) return;
    const headers = {
      authorization: `Bearer ${s.token}`,
      accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": `claude-cli/${claudeCodeVersion()} (external, cli)`,
    };
    const account = s.account?.label ?? "default";

    // The credit balance, alongside the limits, unless it was read recently.
    const previous = (await getCachedReport(24 * 3600_000, { allowPartial: true }))?.claude;
    const recent = recentCredits(previous, account);
    const org = s.account?.org;
    const creditsPromise: Promise<CreditsRead | undefined> = recent || !org
      ? Promise.resolve(recent)
      : fetch(`https://api.anthropic.com/api/oauth/organizations/${encodeURIComponent(org)}/prepaid/credits`, {
          headers,
          signal: AbortSignal.timeout(3500),
        }).then(async (r) => (r.ok ? { credits: claudeCredits(await r.json()), read_at: Date.now() } : undefined))
          .catch(() => undefined);

    const res = await fetch("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", {
      headers,
      signal: AbortSignal.timeout(3500),
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
      const decimals = body.extra_usage?.decimal_places ?? 2;
      const usedMinor = body.spend?.used?.amount_minor ?? body.extra_usage?.used_credits ?? 0;
      const limitMinor = body.spend?.limit?.amount_minor ?? body.extra_usage?.monthly_limit ?? 0;
      const usedPct = body.extra_usage?.utilization ?? body.spend?.percent ?? 0;
      extra_usage = {
        used: money(usedMinor, currency, decimals),
        limit: money(limitMinor, currency, decimals),
        balance_left: money(Math.max(0, limitMinor - usedMinor), currency, decimals),
        used_percent: usedPct,
      };
    }

    const credits = await creditsPromise;
    readAt.claude = Date.now();
    report.claude = {
      account,
      plan: s.plan ?? "pro",
      windows,
      extra_usage,
      limit_resets: claudeLimitResets(body),
      ...(credits ? { credits: credits.credits, credits_read_at: credits.read_at } : {}),
    };
  })().catch(() => {});

  // Fetch Codex
  const codexPromise = (async () => {
    const codexSignIns = await getCodexSignIns().catch(() => []);
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
        signal: AbortSignal.timeout(3500),
      }),
      fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
        headers,
        signal: AbortSignal.timeout(3500),
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

    readAt.codex = Date.now();
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
    // The agy CLI's answer is cached for 2 minutes: its figures are as old as that file.
    let agyReadAt = Date.now();
    try {
      let agyPath = AGY_CACHE_FILE;
      if (!existsSync(agyPath) && existsSync("/tmp/herdr-agy-usage.json")) {
        agyPath = "/tmp/herdr-agy-usage.json";
      }
      if (existsSync(agyPath)) {
        const stat = await Bun.file(agyPath).stat();
        if (Date.now() - stat.mtimeMs < 120_000) {
          agyData = JSON.parse(await Bun.file(agyPath).text());
          agyReadAt = stat.mtimeMs;
        }
      }
    } catch {}

    const agySignIns = await getAntigravitySignIns().catch(() => []);
    const s = agySignIns[0];
    const account = s?.account?.label ?? "default";

    // Invoke the agy CLI when there is no recent cache.
    if (!agyData) {
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
            resets_at: agyReset(b.reset_time ?? b.resetTime),
            description: b.description,
          };
        });
        return {
          name: g.name,
          models,
          buckets,
        };
      });

      readAt.antigravity = agyReadAt;
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
    let res = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    if (!res || !res.ok) {
      res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
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
          resets_at: agyReset(b.resetTime),
        };
      }),
    }));

    if (groups.length > 0) {
      readAt.antigravity = Date.now();
      report.antigravity = {
        account,
        groups,
      };
    }
  })().catch(() => {});

  // Secondary providers (Cursor, Copilot, Grok, OpenCode)
  const othersPromise = fetchOtherProviders()
    .then((others) => {
      report.others = others;
      const now = Date.now();
      for (const p of others) readAt[p.id] = now;
    })
    .catch(() => {});

  await Promise.allSettled([claudePromise, codexPromise, agyPromise, othersPromise]);

  // Merge preserved details and fallback providers from previous cache
  try {
    const prevComplete = await getCachedReport(24 * 3600_000);
    const prevAny = await getCachedReport(24 * 3600_000, { allowPartial: true });

    // Carried-over figures keep the time they were read, so they aren't recorded as new.
    const carry = (id: string, from: FullReport | null) => {
      const t = from?.read_at?.[id];
      if (t) readAt[id] = t;
    };
    if (!report.claude) {
      const from = prevAny?.claude ? prevAny : prevComplete;
      report.claude = from?.claude;
      carry("claude", from);
    }
    // A credit balance that couldn't be read this time keeps the last one read.
    const prevClaude = prevAny?.claude ?? prevComplete?.claude;
    if (report.claude && report.claude.credits === undefined && prevClaude?.account === report.claude.account) {
      report.claude.credits = prevClaude.credits;
      report.claude.credits_read_at = prevClaude.credits_read_at;
    }
    if (!report.codex) {
      const from = prevComplete?.codex ? prevComplete : prevAny;
      report.codex = from?.codex;
      carry("codex", from);
    }
    if (!report.antigravity) {
      const from = prevComplete?.antigravity ? prevComplete : prevAny;
      report.antigravity = from?.antigravity;
      carry("antigravity", from);
    }
    if (report.others.length === 0) {
      const from = prevComplete?.others?.length ? prevComplete : prevAny?.others?.length ? prevAny : null;
      if (from) {
        report.others = from.others;
        for (const p of from.others) carry(p.id, from);
      }
    }

    // Preserve cached Codex reset credits when the provider does not return details.
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

  report.read_at = readAt;
  saveCachedReport(report);
  return report;
}
