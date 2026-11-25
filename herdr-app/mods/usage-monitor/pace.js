// Traffic lights for allowance windows: is capacity going unused before it resets?
//
// A window resets on a clock. If you used it evenly, the share left would match the share of
// time left. More allowance left than time left means you're under pace: at this rate some of it
// resets unused ("untapped"). Much less means you'll run out before the reset ("tight").

import { duration } from "./time.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Spare or short by this many points (allowance % minus time %) changes the light.
export const MARGIN = 20;
// Credits and resets expiring this soon are worth using now.
const CREDIT_SOON = 3 * DAY;

/** A window's length from its label or kind ("5h session", "7d weekly", "Five Hour Limit
 *  Remaining", "week"), or null when it doesn't say. */
export function windowLength(text) {
  const s = String(text ?? "").toLowerCase();
  if (/\b5\s*h\b|five[\s-]hour/.test(s)) return 5 * HOUR;
  if (/\b7\s*d\b|week/.test(s)) return 7 * DAY;
  if (/\b24\s*h\b|\bday\b|daily/.test(s)) return DAY;
  if (/month/.test(s)) return 30 * DAY;
  return null;
}

/**
 * The light for one window.
 * level: "untapped" (under pace: capacity will go unused), "pace", "tight" (will run out), or
 * null when there's nothing to judge. timeLeft: % of the window still to run, when known.
 * spare: allowance % minus time % (positive: ahead, unused).
 */
export function light({ remaining, resetsAt, length, now = Date.now() }) {
  if (!Number.isFinite(remaining)) return { level: null };
  const reset = Date.parse(resetsAt ?? "");
  const msLeft = Number.isFinite(reset) ? reset - now : null;
  if (remaining <= 10) return { level: "tight", msLeft };
  if (msLeft === null || msLeft <= 0 || !length) {
    // No clock to judge pace by: go by what's left.
    return { level: remaining >= 70 ? "untapped" : remaining <= 25 ? "tight" : "pace", msLeft };
  }
  const timeLeft = Math.min(100, (msLeft / length) * 100);
  const spare = remaining - timeLeft;
  const level = spare >= MARGIN ? "untapped" : spare <= -MARGIN ? "tight" : "pace";
  return { level, msLeft, timeLeft, spare };
}

/** Expiring credits: untapped when they expire soon, otherwise nothing to flag. */
export function creditLight({ expiresAt, now = Date.now() }) {
  const expiry = Date.parse(expiresAt ?? "");
  if (!Number.isFinite(expiry) || expiry <= now) return { level: null };
  const msLeft = expiry - now;
  return { level: msLeft <= CREDIT_SOON ? "untapped" : null, msLeft };
}

// Fixed traffic-light colors, not the theme's: their meaning shouldn't depend on it, and many
// themes' terminal green and yellow are too close to tell apart. All three read on dark and light.
const LIGHTS = { untapped: "#2fbf71", pace: "#d4a72c", tight: "#e5534b" };

export function lightColor(t, level) {
  return LIGHTS[level] ?? t.muted;
}

export const LIGHT_LABEL = { untapped: "Untapped", pace: "On pace", tight: "Tight" };

// A reset you hold isn't a pace judgement, so it gets its own fixed color beside the lights.
export const RESET_COLOR = "#3b82f6";

export const WINDOW_NAMES = { session: "Session", day: "Daily", week: "Weekly", month: "Monthly" };

const WEEK = 7 * DAY;

/**
 * Every reset the report says you hold: Claude's limit resets, Codex's reset credits, and any
 * other provider's. Pressing ones come first, then the soonest to expire.
 * usable: false when it's paused or can't be used right now (status says which).
 * urgent: why to use it soon, or null. "tight": one of that provider's limits is tight, and a
 * reset clears it. "expiring": it expires within 3 days. "lastWeek": it expires before the
 * weekly limit resets, so this week is the last it can be used in.
 */
export function heldResets(report, now = Date.now()) {
  const held = [];
  const claude = report?.claude;
  if (claude) {
    held.push(...pressing("claude", claude.windows, (claude.limit_resets ?? []).map((reset) => ({
      label: reset.label,
      count: reset.left ?? 1,
      total: reset.total ?? reset.left ?? 1,
      expiresAt: reset.expires_at,
      usable: !reset.paused && reset.usable_now !== false,
      status: reset.paused ? "Paused" : reset.usable_now === false ? "Can't be used right now" : null,
      needsLimit: Boolean(reset.needs_limit),
      command: "/limit-reset",
    })), now));
  }
  const codex = report?.codex;
  if (codex?.resets) {
    const items = codex.resets.items ?? [];
    const entries = items.map((item) => ({ label: item.title || "Reset credit", count: 1, expiresAt: item.expires_at }));
    // Credits Codex counted but didn't detail.
    const undetailed = (codex.resets.available ?? 0) - items.length;
    if (undetailed > 0) entries.push({ label: "Reset credit", count: undetailed, expiresAt: null });
    held.push(...pressing("codex", codex.windows, entries, now));
  }
  for (const provider of report?.others ?? []) {
    if (!(provider.resets?.available > 0)) continue;
    const windows = (provider.windows ?? []).map((entry) => ({
      ...entry, label: [WINDOW_NAMES[entry.kind] ?? entry.kind, entry.scope].filter(Boolean).join(" · "),
      length: windowLength(entry.kind),
    }));
    held.push(...pressing(provider.id, windows, [{
      label: "Reset credits", count: provider.resets.available, expiresAt: provider.resets.expires_at,
    }], now));
  }
  const expiry = (entry) => entry.msLeft ?? Infinity;
  return held.sort((a, b) => Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) || expiry(a) - expiry(b));
}

// One provider's resets, each with how long it has left and whether it's pressing.
function pressing(provider, windows, entries, now) {
  const limits = (windows ?? []).map((entry) => {
    const length = entry.length ?? windowLength(entry.label);
    return { label: entry.label, resetsAt: entry.resets_at, length,
      ...light({ remaining: 100 - Math.round(entry.used_percent), resetsAt: entry.resets_at, length, now }) };
  });
  const tight = limits.find((limit) => limit.level === "tight");
  const weekly = limits.find((limit) => limit.length === WEEK && Date.parse(limit.resetsAt ?? "") > now);
  const weekEnds = weekly ? Date.parse(weekly.resetsAt) : null;
  return entries.map((entry) => {
    const expiry = Date.parse(entry.expiresAt ?? "");
    const msLeft = Number.isFinite(expiry) ? expiry - now : null;
    const usable = entry.usable ?? true;
    const urgent = !usable ? null
      : tight ? "tight"
      : msLeft !== null && msLeft <= CREDIT_SOON ? "expiring"
      : msLeft !== null && weekEnds !== null && expiry < weekEnds ? "lastWeek" : null;
    return {
      provider, total: entry.count, status: null, needsLimit: false, command: null,
      ...entry, usable, msLeft, urgent, tightLimit: urgent === "tight" ? tight.label : null,
    };
  }).filter((entry) => entry.msLeft === null || entry.msLeft > 0);
}

/**
 * One provider's hover text in the readout, and nothing about the others: its name, each of its
 * limits with what's left and when it resets, then the resets it holds.
 */
export function providerDetail(report, id, name, now = Date.now()) {
  const limit = (label, remaining, resetsAt) => {
    const ms = Date.parse(resetsAt ?? "") - now;
    return `${label}: ${Math.round(remaining)}% left${ms > 0 ? ` · resets in ${duration(ms)}` : ""}`;
  };
  const left = (used) => 100 - Math.round(used);
  const other = (report?.others ?? []).find((provider) => provider.id === id);
  const limits = id === "claude" || id === "codex"
    ? (report?.[id]?.windows ?? []).map((entry) => limit(entry.label, left(entry.used_percent), entry.resets_at))
    : id === "antigravity"
      ? (report?.antigravity?.groups ?? []).flatMap((group) => (group.buckets ?? [])
        .map((entry) => limit(`${group.name} · ${entry.label}`, entry.remaining_percent, entry.resets_at)))
      : (other?.windows ?? []).map((entry) => limit(
        [WINDOW_NAMES[entry.kind] ?? entry.kind, entry.scope].filter(Boolean).join(" · "),
        left(entry.used_percent), entry.resets_at));
  const problem = other?.problem === "expired" ? "Sign-in expired" : other?.problem;
  const resets = heldResets(report, now).filter((entry) => entry.provider === id).map((entry) => [
    entry.count > 1 ? `${entry.label} (${entry.count})` : entry.label,
    resetNote(entry), entry.usable && entry.command && `run ${entry.command}`,
  ].filter(Boolean).join(" · "));
  return [name, ...[problem].filter(Boolean), ...limits, ...(resets.length ? ["", "Resets you hold", ...resets] : [])]
    .join("\n");
}

/** Why a held reset matters now, and when it expires: "Last week to use it · expires in 5d 2h". */
export function resetNote(entry) {
  const why = entry.status
    ?? (entry.urgent === "tight" ? `${entry.tightLimit} is tight`
      : entry.urgent === "expiring" ? "Use it or lose it"
      : entry.urgent === "lastWeek" ? "Last week to use it"
      : entry.needsLimit ? "Use it at a limit" : "");
  const expires = Number.isFinite(entry.msLeft) ? `expires in ${duration(entry.msLeft)}` : "";
  return [why, expires].filter(Boolean).join(" · ");
}
