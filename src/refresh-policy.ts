import type { FullReport } from "./fetcher.ts";

export const ACTIVE_IDLE_THRESHOLD_MS = 15 * 60_000;    // 15 minutes
export const COOLING_IDLE_THRESHOLD_MS = 2 * 3600_000;  // 2 hours

export const ACTIVE_POLL_INTERVAL_MS = 3 * 60_000;      // 3 minutes
export const COOLING_POLL_INTERVAL_MS = 15 * 60_000;    // 15 minutes
export const DORMANT_POLL_INTERVAL_MS = 60 * 60_000;    // 60 minutes

/** Clock-skew margin before treating an OAuth access token as expired. */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

const validTime = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** The maximum age of cached figures before an activity-tracked provider should be queried again. */
export function providerTtl(lastActivityAt: number | null | undefined, now = Date.now()): number {
  const at = validTime(lastActivityAt);
  if (!at) return COOLING_POLL_INTERVAL_MS;
  const idleMs = Math.max(0, now - at);
  if (idleMs < ACTIVE_IDLE_THRESHOLD_MS) return ACTIVE_POLL_INTERVAL_MS;
  if (idleMs < COOLING_IDLE_THRESHOLD_MS) return COOLING_POLL_INTERVAL_MS;
  return DORMANT_POLL_INTERVAL_MS;
}

/** Secondary providers have no local usage logs, so never poll faster than the cooling interval. */
export function othersTtl(lastGeneralActivityAt: number | null | undefined, now = Date.now()): number {
  const at = validTime(lastGeneralActivityAt);
  if (!at) return COOLING_POLL_INTERVAL_MS;
  const idleMs = Math.max(0, now - at);
  return idleMs < COOLING_IDLE_THRESHOLD_MS ? COOLING_POLL_INTERVAL_MS : DORMANT_POLL_INTERVAL_MS;
}

/** True when any cached quota window reset between the last check and now. */
export function hasPassedReset(
  resetsAt: Array<string | null | undefined> | undefined,
  lastCheckAt: number,
  now: number,
): boolean {
  if (!resetsAt?.length || lastCheckAt <= 0) return false;
  for (const iso of resetsAt) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isFinite(t) && t > 0 && t > lastCheckAt && now >= t) {
      return true;
    }
  }
  return false;
}

/** True when an OAuth token is past its expiry beyond clock-skew tolerance. */
export function isTokenExpired(expiresAt: number | null | undefined, now = Date.now()): boolean {
  const exp = validTime(expiresAt);
  return exp > 0 && exp <= now - TOKEN_EXPIRY_SKEW_MS;
}

export interface RefreshDecisionInput {
  lastReadAt?: number;
  lastAttemptAt?: number;
  lastActivityAt?: number | null;
  resetsAt?: Array<string | null | undefined>;
  cooldownUntil?: number;
  ttl?: number;
  now?: number;
  force?: boolean;
}

/** Whether a provider should be queried over the network right now. */
export function shouldRefreshProvider(input: RefreshDecisionInput): boolean {
  const now = input.now ?? Date.now();
  const cooldown = validTime(input.cooldownUntil);
  if (cooldown > 0 && now < cooldown) return false;
  if (input.force) return true;

  const lastCheck = Math.max(validTime(input.lastReadAt), validTime(input.lastAttemptAt));
  if (lastCheck === 0) return true;
  if (hasPassedReset(input.resetsAt, lastCheck, now)) return true;

  const ttl = input.ttl ?? providerTtl(input.lastActivityAt, now);
  return now - lastCheck >= ttl;
}

export interface RefreshPlanOptions {
  activity: Record<string, number>;
  claudeUntil?: number;
  now?: number;
  force?: boolean;
}

export interface ProviderRefreshPlan {
  claude: boolean;
  codex: boolean;
  antigravity: boolean;
  others: boolean;
  any: boolean;
  ttls: Record<string, number>;
}

/** Decide which providers need a network refresh and record each provider's active TTL. */
export function planProviderRefreshes(
  report: FullReport | null | undefined,
  options: RefreshPlanOptions,
): ProviderRefreshPlan {
  const now = options.now ?? Date.now();
  const force = Boolean(options.force);
  const activity = options.activity;

  const claudeTtl = providerTtl(activity["claude"], now);
  const codexTtl = providerTtl(activity["codex"], now);
  const agyTtl = providerTtl(activity["antigravity"], now);

  const generalActivity = Object.values(activity).reduce((max, t) => Math.max(max, validTime(t)), 0);
  const secondaryTtl = othersTtl(generalActivity > 0 ? generalActivity : undefined, now);

  const claude = shouldRefreshProvider({
    lastReadAt: report?.read_at?.["claude"],
    lastAttemptAt: report?.attempted_at?.["claude"],
    lastActivityAt: activity["claude"],
    resetsAt: report?.claude?.windows?.map((w) => w.resets_at),
    cooldownUntil: options.claudeUntil,
    ttl: claudeTtl,
    now,
    force,
  });

  const codex = shouldRefreshProvider({
    lastReadAt: report?.read_at?.["codex"],
    lastAttemptAt: report?.attempted_at?.["codex"],
    lastActivityAt: activity["codex"],
    resetsAt: report?.codex?.windows?.map((w) => w.resets_at),
    ttl: codexTtl,
    now,
    force,
  });

  const antigravity = shouldRefreshProvider({
    lastReadAt: report?.read_at?.["antigravity"],
    lastAttemptAt: report?.attempted_at?.["antigravity"],
    lastActivityAt: activity["antigravity"],
    resetsAt: report?.antigravity?.groups?.flatMap((g) => g.buckets.map((b) => b.resets_at)),
    ttl: agyTtl,
    now,
    force,
  });

  const othersLastRead = report?.others?.length
    ? Math.min(...report.others.map((p) => validTime(report.read_at?.[p.id])))
    : undefined;
  const others = shouldRefreshProvider({
    lastReadAt: othersLastRead && othersLastRead > 0 ? othersLastRead : undefined,
    lastAttemptAt: report?.attempted_at?.["others"],
    resetsAt: report?.others?.flatMap((p) => p.windows.map((w) => w.resets_at)),
    ttl: secondaryTtl,
    now,
    force,
  });

  const ttls: Record<string, number> = {
    claude: claudeTtl,
    codex: codexTtl,
    antigravity: agyTtl,
    others: secondaryTtl,
  };
  for (const provider of report?.others ?? []) {
    ttls[provider.id] = secondaryTtl;
  }

  return {
    claude,
    codex,
    antigravity,
    others,
    any: claude || codex || antigravity || others,
    ttls,
  };
}
