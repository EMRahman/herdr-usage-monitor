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
  type SignIn,
} from "./providers.ts";
import { latestModelActivity } from "./history/model-usage.ts";
import { isTokenExpired, planProviderRefreshes } from "./refresh-policy.ts";

const CACHE_DIR =
  process.env["HERDR_USAGE_CACHE_DIR"] ??
  (process.env["XDG_CACHE_HOME"]
    ? join(process.env["XDG_CACHE_HOME"], "herdr-usage-monitor")
    : join(homedir(), ".cache", "herdr-usage-monitor"));

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
  /** When each provider slot (claude, codex, antigravity, others) was last checked (ms),
   *  including failed, empty, or expired-token checks so backoff applies without retrying every minute. */
  attempted_at?: Record<string, number>;
  /** Active adaptive refresh interval (ms) per provider at the time the report was produced. */
  ttl?: Record<string, number>;
}

export interface RateLimitState {
  claudeUntil?: number;
}

export async function getRateLimitsAsync(cacheDir = CACHE_DIR): Promise<RateLimitState> {
  try {
    const file = Bun.file(join(cacheDir, "rate-limits.json"));
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

function saveRateLimits(state: RateLimitState, cacheDir = CACHE_DIR): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "rate-limits.json"), JSON.stringify(state));
  } catch {}
}

async function readCacheFile(
  path: string,
  maxAgeMs: number,
  now = Date.now(),
  allowLegacyTmp = true,
): Promise<FullReport | null> {
  try {
    let file = Bun.file(path);
    if (allowLegacyTmp && !(await file.exists())) {
      const legacyPath = join("/tmp", basename(path));
      const legacyFile = Bun.file(legacyPath);
      if (await legacyFile.exists()) {
        file = legacyFile;
      }
    }
    if (await file.exists()) {
      const data = JSON.parse(await file.text()) as FullReport;
      if (now - (data.timestamp || 0) < maxAgeMs) {
        return data;
      }
    }
  } catch {}
  return null;
}

export async function getCachedReport(
  maxAgeMs = 300_000,
  options?: { allowPartial?: boolean; now?: number; cacheDir?: string },
): Promise<FullReport | null> {
  const dir = options?.cacheDir ?? CACHE_DIR;
  const now = options?.now ?? Date.now();
  const allowLegacyTmp = !options?.cacheDir;
  const complete = await readCacheFile(join(dir, "herdr-usage-cache.json"), maxAgeMs, now, allowLegacyTmp);
  if (!options?.allowPartial) {
    return complete && !complete.partial ? complete : null;
  }
  const partial = await readCacheFile(join(dir, "herdr-usage-fast-cache.json"), maxAgeMs, now, allowLegacyTmp);
  if (complete && partial) {
    return complete.timestamp >= partial.timestamp ? complete : partial;
  }
  return complete ?? partial;
}

function saveCachedReport(report: FullReport, cacheDir = CACHE_DIR): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "herdr-usage-cache.json"), JSON.stringify(report));
  } catch {}
}

export interface FetchReportDeps {
  fetch?: typeof fetch;
  getClaudeSignIns?: () => Promise<SignIn[]>;
  getCodexSignIns?: () => Promise<SignIn[]>;
  getAntigravitySignIns?: () => Promise<SignIn[]>;
  fetchOtherProviders?: () => Promise<GenericProvider[]>;
  resolveBinary?: (name: string) => string | null;
}

export interface FetchReportOptions {
  /** When true, queries all providers regardless of activity-based idle backoff. */
  force?: boolean;
  /** Activity timestamps by provider id (e.g. from latestModelActivity()). */
  activity?: Record<string, number>;
  /** Reference timestamp in ms. Defaults to Date.now(). */
  now?: number;
  /** Override cache directory (primarily for tests). */
  cacheDir?: string;
  /** Dependency overrides (primarily for tests). */
  deps?: FetchReportDeps;
}

export async function fetchDetailedReport(options: FetchReportOptions = {}): Promise<FullReport> {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const clock = () => options.now ?? Date.now();
  const now = clock();
  const force = Boolean(options.force);
  const activity = options.activity ?? latestModelActivity();
  const fetchFn = options.deps?.fetch ?? fetch;
  const claudeSignInsFn = options.deps?.getClaudeSignIns ?? getClaudeSignIns;
  const codexSignInsFn = options.deps?.getCodexSignIns ?? getCodexSignIns;
  const agySignInsFn = options.deps?.getAntigravitySignIns ?? getAntigravitySignIns;
  const otherProvidersFn = options.deps?.fetchOtherProviders ?? fetchOtherProviders;
  const resolveBinaryFn = options.deps?.resolveBinary ?? resolveBinary;

  const [limits, prevAny, prevComplete] = await Promise.all([
    getRateLimitsAsync(cacheDir),
    getCachedReport(24 * 3600_000, { allowPartial: true, now, cacheDir }),
    getCachedReport(24 * 3600_000, { now, cacheDir }),
  ]);

  const plan = planProviderRefreshes(prevAny, {
    activity,
    claudeUntil: limits.claudeUntil,
    now,
    force,
  });

  const report: FullReport = {
    timestamp: now,
    others: [],
  };
  const readAt: Record<string, number> = {};
  const attemptedAt: Record<string, number> = { ...(prevComplete?.attempted_at ?? prevAny?.attempted_at) };

  // Fetch Claude (discovers its own credentials so slow Keychain never blocks other providers)
  const claudePromise = (async () => {
    if (!plan.claude) return;
    attemptedAt.claude = now;

    const claudeSignIns = await claudeSignInsFn().catch(() => []);
    const s = claudeSignIns[0];
    if (!s) return;
    if (!force && isTokenExpired(s.expiresAt, now)) return;
    const headers = {
      authorization: `Bearer ${s.token}`,
      accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": `claude-cli/${claudeCodeVersion()} (external, cli)`,
    };
    const account = s.account?.label ?? "default";

    // The credit balance, alongside the limits, unless it was read recently.
    const previous = prevAny?.claude;
    const recent = recentCredits(previous, account, now);
    const org = s.account?.org;
    const creditsPromise: Promise<CreditsRead | undefined> = recent || !org
      ? Promise.resolve(recent)
      : fetchFn(`https://api.anthropic.com/api/oauth/organizations/${encodeURIComponent(org)}/prepaid/credits`, {
          headers,
          signal: AbortSignal.timeout(3500),
        }).then(async (r) => (r.ok ? { credits: claudeCredits(await r.json(), clock()), read_at: clock() } : undefined))
          .catch(() => undefined);

    const res = await fetchFn("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", {
      headers,
      signal: AbortSignal.timeout(3500),
    }).catch(() => null);

    if (!res) return;

    if (res.status === 429) {
      const retryHeader = res.headers.get("retry-after");
      const retrySec = retryHeader ? parseInt(retryHeader, 10) : NaN;
      const cooldownMs = Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : 300_000;
      saveRateLimits({ ...limits, claudeUntil: clock() + cooldownMs }, cacheDir);
      return;
    }

    if (!res.ok) return;

    if (limits.claudeUntil) {
      delete limits.claudeUntil;
      saveRateLimits(limits, cacheDir);
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
    readAt.claude = clock();
    report.claude = {
      account,
      plan: s.plan ?? "pro",
      windows,
      extra_usage,
      limit_resets: claudeLimitResets(body, now),
      ...(credits ? { credits: credits.credits, credits_read_at: credits.read_at } : {}),
    };
  })().catch(() => {});

  // Fetch Codex
  const codexPromise = (async () => {
    if (!plan.codex) return;
    attemptedAt.codex = now;

    const codexSignIns = await codexSignInsFn().catch(() => []);
    const s = codexSignIns[0];
    if (!s) return;
    if (!force && isTokenExpired(s.expiresAt, now)) return;
    const headers: Record<string, string> = {
      authorization: `Bearer ${s.token}`,
      accept: "application/json",
      ...(s.chatgptAccount ? { "chatgpt-account-id": s.chatgptAccount } : {}),
    };
    const [usageRes, creditsRes] = await Promise.all([
      fetchFn("https://chatgpt.com/backend-api/wham/usage", {
        headers,
        signal: AbortSignal.timeout(3500),
      }),
      fetchFn("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
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

    readAt.codex = clock();
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
    if (!plan.antigravity) return;
    attemptedAt.antigravity = now;

    // Try reading recent agy cache first before touching Keychain
    let agyData: any = null;
    // The agy CLI's answer is cached for 2 minutes: its figures are as old as that file.
    let agyReadAt = clock();
    const agyCacheFile = join(cacheDir, "herdr-agy-usage.json");
    try {
      let agyPath = agyCacheFile;
      if (!options.cacheDir && !existsSync(agyPath) && existsSync("/tmp/herdr-agy-usage.json")) {
        agyPath = "/tmp/herdr-agy-usage.json";
      }
      if (existsSync(agyPath)) {
        const stat = await Bun.file(agyPath).stat();
        if (clock() - stat.mtimeMs < 120_000) {
          agyData = JSON.parse(await Bun.file(agyPath).text());
          agyReadAt = stat.mtimeMs;
        }
      }
    } catch {}

    const agySignIns = await agySignInsFn().catch(() => []);
    const s = agySignIns[0];
    const account = s?.account?.label ?? "default";

    // Invoke the agy CLI when there is no recent cache.
    if (!agyData) {
      const agyBin = resolveBinaryFn("agy");
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
                mkdirSync(cacheDir, { recursive: true });
                writeFileSync(agyCacheFile, JSON.stringify(agyData));
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
    if (!s || (!force && isTokenExpired(s.expiresAt, now))) return;
    const headers = {
      authorization: `Bearer ${s.token}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "antigravity",
    };
    let res = await fetchFn("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    if (!res || !res.ok) {
      res = await fetchFn("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
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
      readAt.antigravity = clock();
      report.antigravity = {
        account,
        groups,
      };
    }
  })().catch(() => {});

  // Secondary providers (Cursor, Copilot, Grok, OpenCode)
  const othersPromise = (async () => {
    if (!plan.others) return;
    attemptedAt.others = now;
    const others = await otherProvidersFn();
    report.others = others;
    const fetchNow = clock();
    for (const p of others) readAt[p.id] = fetchNow;
  })().catch(() => {});

  await Promise.allSettled([claudePromise, codexPromise, agyPromise, othersPromise]);

  // Reload cache after network requests settle so a slower selective poll never overwrites
  // newer per-provider readings saved by a concurrent refresh.
  try {
    const mergeNow = clock();
    const [diskAny, diskComplete] = await Promise.all([
      getCachedReport(24 * 3600_000, { allowPartial: true, now: mergeNow, cacheDir }),
      getCachedReport(24 * 3600_000, { now: mergeNow, cacheDir }),
    ]);
    const sources = [diskAny, diskComplete, prevAny, prevComplete].filter((s): s is FullReport => Boolean(s));

    const newestSourceFor = <K extends "claude" | "codex" | "antigravity">(id: K): FullReport | null => {
      let best: FullReport | null = null;
      let bestTime = -1;
      for (const src of sources) {
        if (!src[id]) continue;
        const t = src.read_at?.[id] ?? 0;
        if (!best || t > bestTime) {
          best = src;
          bestTime = t;
        }
      }
      return best;
    };

    const mergePrimary = <K extends "claude" | "codex" | "antigravity">(id: K) => {
      const from = newestSourceFor(id);
      if (!from?.[id]) return;
      const fromTime = from.read_at?.[id] ?? 0;
      const curTime = readAt[id] ?? 0;
      if (!report[id] || fromTime > curTime) {
        report[id] = from[id];
        if (fromTime > 0) readAt[id] = fromTime;
      }
    };

    mergePrimary("claude");
    // A credit balance that couldn't be read this time keeps the newest one read for this account.
    if (report.claude) {
      let bestCredits = report.claude.credits;
      let bestCreditsAt = report.claude.credits_read_at ?? -1;
      for (const src of sources) {
        const c = src.claude;
        if (!c || c.account !== report.claude.account || c.credits === undefined) continue;
        const at = c.credits_read_at ?? 0;
        if (bestCredits === undefined || at > bestCreditsAt) {
          bestCredits = c.credits;
          bestCreditsAt = at;
        }
      }
      if (bestCredits !== undefined) {
        report.claude.credits = bestCredits;
        if (bestCreditsAt >= 0) report.claude.credits_read_at = bestCreditsAt;
      }
    }

    mergePrimary("codex");
    mergePrimary("antigravity");

    // Merge secondary providers, keeping the newest per-provider reading if a concurrent refresh ran.
    const newestOthers = sources.find((src) => src.others?.length > 0) ?? null;
    if (report.others.length === 0) {
      if (newestOthers) {
        report.others = newestOthers.others;
        for (const p of newestOthers.others) {
          const t = newestOthers.read_at?.[p.id];
          if (t) readAt[p.id] = t;
        }
      }
    } else if (newestOthers) {
      const byId = new Map<string, GenericProvider>();
      for (const p of report.others) byId.set(p.id, p);
      for (const p of newestOthers.others) {
        const fromTime = newestOthers.read_at?.[p.id] ?? 0;
        const curTime = readAt[p.id] ?? 0;
        if (byId.has(p.id) && fromTime > curTime) {
          byId.set(p.id, p);
          if (fromTime > 0) readAt[p.id] = fromTime;
        }
      }
      report.others = [...byId.values()];
    }

    // Preserve the newest attempted_at timestamps across concurrent polls.
    for (const src of sources) {
      for (const [id, t] of Object.entries(src.attempted_at ?? {})) {
        if (typeof t === "number" && Number.isFinite(t) && t > (attemptedAt[id] ?? 0)) {
          attemptedAt[id] = t;
        }
      }
    }

    // Preserve cached Codex reset credits when the provider does not return details.
    const codexWithItems = sources.find(
      (src) => src.codex?.account === report.codex?.account && src.codex.resets.items.length > 0,
    );
    if (
      report.codex &&
      report.codex.resets.available > 0 &&
      report.codex.resets.items.length === 0 &&
      codexWithItems?.codex
    ) {
      report.codex.resets.items = codexWithItems.codex.resets.items
        .filter((item) => {
          const exp = Date.parse(item.expires_at);
          return !Number.isFinite(exp) || exp > mergeNow;
        })
        .slice(0, report.codex.resets.available);
    }

    // Keep report.timestamp at least as new as any concurrent cache write we merged from.
    for (const src of sources) {
      if (src.timestamp > report.timestamp) report.timestamp = src.timestamp;
    }
  } catch {}

  report.read_at = readAt;
  report.attempted_at = attemptedAt;
  const ttls: Record<string, number> = { ...plan.ttls };
  for (const p of report.others) ttls[p.id] = plan.ttls.others!;
  report.ttl = ttls;
  saveCachedReport(report, cacheDir);
  return report;
}
