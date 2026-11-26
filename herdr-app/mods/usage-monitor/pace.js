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
// Under two days left on a low weekly limit: save a held reset and wait for the weekly refresh.
const WAIT_SOON = 2 * DAY;
// Credits expiring this soon, or 3+ days left on a low weekly limit, are worth using now.
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
      paused: Boolean(reset.paused),
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

function isWeeklyLow(weekly) {
  if (!weekly || !Number.isFinite(weekly.msLeft) || weekly.msLeft <= 0) return false;
  return weekly.level === "tight" || weekly.remaining <= (weekly.msLeft < CREDIT_SOON ? 25 : 30);
}

function pickBindingWeekly(list) {
  if (!list.length) return null;
  return [...list].sort((a, b) => a.remaining - b.remaining || (a.spare ?? 0) - (b.spare ?? 0))[0];
}

// One provider's resets, each with how long it has left and whether it's pressing.
function pressing(provider, windows, entries, now) {
  const limits = (windows ?? []).map((entry) => {
    const length = entry.length ?? windowLength(entry.label);
    return { label: entry.label, resetsAt: entry.resets_at, length,
      remaining: 100 - Math.round(entry.used_percent),
      ...light({ remaining: 100 - Math.round(entry.used_percent), resetsAt: entry.resets_at, length, now }) };
  });
  const activeWeeks = limits.filter((limit) => limit.length === WEEK && Date.parse(limit.resetsAt ?? "") > now);
  const weekly = pickBindingWeekly(activeWeeks);
  const weekEnds = weekly ? Date.parse(weekly.resetsAt) : null;
  const saveForSoonWeekly = weekly && isWeeklyLow(weekly) && weekly.msLeft < WAIT_SOON;
  const lowWeekly = weekly && isWeeklyLow(weekly) && weekly.msLeft >= CREDIT_SOON;
  return entries.map((entry) => {
    const expiry = Date.parse(entry.expiresAt ?? "");
    const msLeft = Number.isFinite(expiry) ? expiry - now : null;
    const usable = entry.usable ?? true;
    const expiresBeforeWeekly = msLeft !== null && weekEnds !== null && expiry <= weekEnds;
    const lastChanceGated = Boolean(entry.needsLimit) && usable && msLeft !== null && weekEnds !== null
      && expiry > weekEnds && expiry - weekEnds < WAIT_SOON;
    const tight = limits.find((limit) => limit.level === "tight"
      && !(!expiresBeforeWeekly && !lastChanceGated && saveForSoonWeekly && limit.length === WEEK));
    const urgent = !usable ? null
      : tight ? "tight"
      : lowWeekly ? "lowWeekly"
      : msLeft !== null && msLeft <= CREDIT_SOON ? "expiring"
      : expiresBeforeWeekly ? "lastWeek" : null;
    return {
      provider, total: entry.count, status: null, paused: false, needsLimit: false, command: null,
      ...entry, usable, msLeft, urgent, tightLimit: urgent === "tight" ? tight.label : null,
    };
  }).filter((entry) => entry.msLeft === null || entry.msLeft > 0);
}

function windowOfLength(report, provider, group, targetLength, now) {
  const fromWindows = (entries) => {
    const matches = [];
    for (const entry of entries ?? []) {
      const label = entry.label ?? entry.kind;
      const length = windowLength(label);
      if (length !== targetLength) continue;
      const remaining = Number.isFinite(entry.remaining_percent)
        ? entry.remaining_percent
        : 100 - Math.round(entry.used_percent);
      matches.push({ label, remaining, ...light({ remaining, resetsAt: entry.resets_at, length, now }) });
    }
    const active = matches.filter((w) => Number.isFinite(w.msLeft) && w.msLeft > 0);
    return pickBindingWeekly(active) ?? matches[0] ?? null;
  };
  if (provider === "Claude" || provider === "claude") return fromWindows(report?.claude?.windows);
  if (provider === "Codex" || provider === "codex") return fromWindows(report?.codex?.windows);
  if (provider === "Antigravity" || provider === "antigravity") {
    const groups = report?.antigravity?.groups ?? [];
    if (group) {
      const match = groups.find((entry) => entry.name === group);
      return fromWindows(match?.buckets);
    }
    for (const entry of groups) {
      const found = fromWindows(entry?.buckets);
      if (found && Number.isFinite(found.msLeft) && found.msLeft > 0) return found;
    }
    return fromWindows(groups[0]?.buckets);
  }
  const other = (report?.others ?? []).find((entry) => entry.id === provider || entry.name === provider);
  return fromWindows(other?.windows);
}

function weeklyFor(report, provider, group, now) {
  return windowOfLength(report, provider, group, WEEK, now);
}

function sessionFor(report, provider, group, now) {
  return windowOfLength(report, provider, group, 5 * HOUR, now);
}

function providerKey(provider) {
  const s = String(provider ?? "").toLowerCase();
  if (s === "claude") return "claude";
  if (s === "codex") return "codex";
  if (s === "antigravity") return "antigravity";
  return s;
}

// Resets that count toward planning: currently usable ones, plus non-paused resets that require
// hitting a limit before they unlock, ordered strictly by soonest expiry first.
function planResetsFor(report, provider, now = Date.now()) {
  const id = providerKey(provider);
  const expiry = (entry) => entry.msLeft ?? Infinity;
  return heldResets(report, now)
    .filter((entry) => entry.provider === id && !entry.paused && (entry.usable || entry.needsLimit))
    .sort((a, b) => expiry(a) - expiry(b));
}

// When more than one reset is held and fewer weekly refreshes remain before they expire than
// resets expiring by that time, returns the earliest-expiring reset in the surplus batch.
function surplusExpiring(planResets, weekly) {
  if (!weekly || !Number.isFinite(weekly.msLeft) || weekly.msLeft <= 0) return null;
  const total = planResets.reduce((sum, entry) => sum + entry.count, 0);
  if (total <= 1) return null;
  let cumulative = 0;
  for (const entry of planResets) {
    if (entry.msLeft === null) continue;
    cumulative += entry.count;
    const refreshes = entry.msLeft < weekly.msLeft ? 0 : 1 + Math.floor((entry.msLeft - weekly.msLeft) / WEEK);
    if (cumulative > 1 && cumulative > refreshes) {
      return planResets.find((r) => r.msLeft !== null) ?? entry;
    }
  }
  return null;
}

export function usableResetsFor(report, provider, now = Date.now()) {
  return planResetsFor(report, provider, now)
    .reduce((sum, entry) => sum + entry.count, 0);
}

/** One-line reset availability summary for a provider's burndown card, e.g. "2 resets available · next expires in 16d 4h". */
export function resetSummary(report, provider, now = Date.now()) {
  const id = providerKey(provider);
  const entries = heldResets(report, now).filter((entry) => entry.provider === id);
  const data = report?.[id] ?? (report?.others ?? []).find((p) => p.id === id);
  const reported = Array.isArray(data?.limit_resets) || Number.isFinite(data?.resets?.available);
  if (!entries.length && !reported) return "";
  const usable = entries.filter((e) => e.usable);
  const count = usable.reduce((sum, e) => sum + e.count, 0);
  const parts = [`${count} reset${count === 1 ? "" : "s"} available`];
  for (const status of new Set(entries.filter((e) => !e.usable && e.status).map((e) => e.status))) {
    const n = entries.filter((e) => e.status === status).reduce((sum, e) => sum + e.count, 0);
    parts.push(`${n} ${status.toLowerCase()}`);
  }
  const next = usable.find((e) => Number.isFinite(e.msLeft));
  if (next) parts.push(`next expires in ${duration(next.msLeft)}`);
  return parts.join(" · ");
}

/**
 * Turns raw untapped windows into actionable advice:
 * - "use": lots of weekly left (or no weekly limit) -> use this allowance.
 * - "wait": 5h is untapped, weekly is low, and reset is soon (< 2d, or < 3d without extra resets) -> wait for weekly reset.
 * - "reset": 5h is untapped, weekly is low, 3+ days remain, and a reset is held -> use remaining weekly, then use a reset.
 * - "pace": 5h is untapped, weekly is low, 2+ days remain, and no reset is held -> stay steady on weekly.
 */
export function adviseUntapped(spares, report, now = Date.now()) {
  const rank = { use: 0, reset: 1, pace: 2, wait: 3 };
  return spares.map((spare) => {
    if (spare.credit || spare.length !== 5 * HOUR) return { ...spare, kind: "use" };
    const weekly = weeklyFor(report, spare.provider, spare.group, now);
    if (!isWeeklyLow(weekly)) {
      return { ...spare, kind: "use" };
    }
    const planResets = planResetsFor(report, spare.provider, now);
    const resets = planResets.reduce((sum, entry) => sum + entry.count, 0);
    const expiresBeforeWeekly = planResets.some((entry) => entry.msLeft !== null && entry.msLeft <= weekly.msLeft);
    const surplus = Boolean(surplusExpiring(planResets, weekly));
    const lastChanceGated = planResets.some((entry) => entry.needsLimit && entry.usable
      && entry.msLeft !== null && entry.msLeft > weekly.msLeft && entry.msLeft - weekly.msLeft < WAIT_SOON);
    if (resets > 0 && (expiresBeforeWeekly || surplus || lastChanceGated)) {
      return { ...spare, kind: "reset", weeklyMsLeft: weekly.msLeft, weeklyRemaining: weekly.remaining, resets };
    }
    if (weekly.msLeft < WAIT_SOON || (weekly.msLeft < CREDIT_SOON && resets <= 1)) {
      return { ...spare, kind: "wait", weeklyMsLeft: weekly.msLeft, weeklyRemaining: weekly.remaining, resets };
    }
    if (resets > 0) {
      return { ...spare, kind: "reset", weeklyMsLeft: weekly.msLeft, weeklyRemaining: weekly.remaining, resets };
    }
    return { ...spare, kind: "pace", weeklyMsLeft: weekly.msLeft, weeklyRemaining: weekly.remaining, resets: 0 };
  }).sort((a, b) => rank[a.kind] - rank[b.kind] || (a.msLeft ?? Infinity) - (b.msLeft ?? Infinity));
}

function weeklyScopeLabel(weekly) {
  const label = String(weekly?.label ?? "").trim();
  if (!label || /^(7\s*d\s+)?weekly(\s+limit(\s+remaining)?)?$/i.test(label)) return "weekly";
  return label;
}

function suggestionForSessionLock(session, planResets, weekly = null) {
  const resets = planResets.reduce((sum, entry) => sum + entry.count, 0);
  const expiring = planResets.find((entry) => entry.msLeft !== null && entry.msLeft <= session.msLeft)
    ?? surplusExpiring(planResets, weekly);
  if (expiring) {
    return {
      kind: "reset",
      level: "reset",
      text: session.remaining > 0
        ? `Use up remaining 5h session (${Math.round(session.remaining)}% left), then use a reset (expires in ${duration(expiring.msLeft)})`
        : `Use a reset before it expires in ${duration(expiring.msLeft)}`,
    };
  }
  if (session.msLeft < HOUR || resets <= 1) {
    return {
      kind: "wait",
      level: "pace",
      text: resets > 0
        ? `Save the reset: Wait for 5h refresh in ${duration(session.msLeft)}`
        : `Wait for 5h refresh in ${duration(session.msLeft)}`,
    };
  }
  return {
    kind: "wait",
    level: "pace",
    text: `Wait for 5h refresh in ${duration(session.msLeft)} (or redeem 1 reset if urgent)`,
  };
}

function suggestionForWeekly(weekly, session, planResets, resetNoun) {
  const resets = planResets.reduce((sum, entry) => sum + entry.count, 0);
  const scope = weeklyScopeLabel(weekly);
  const directExpiring = planResets.find((entry) => entry.msLeft !== null && entry.msLeft <= weekly.msLeft);
  const expiring = directExpiring ?? surplusExpiring(planResets, weekly);
  const lastChance = planResets.find((entry) => entry.needsLimit && entry.usable
    && entry.msLeft !== null && entry.msLeft > weekly.msLeft && entry.msLeft - weekly.msLeft < WAIT_SOON);
  if (isWeeklyLow(weekly)) {
    if (resets > 0) {
      if (expiring) {
        return {
          kind: "reset",
          level: "reset",
          text: weekly.remaining > 0
            ? `Use up remaining ${scope} (${Math.round(weekly.remaining)}% left), then use a reset (expires in ${duration(expiring.msLeft)})`
            : `Use a reset before it expires in ${duration(expiring.msLeft)}`,
        };
      }
      if (lastChance) {
        return {
          kind: "reset",
          level: "reset",
          text: `Last chance: use a reset before ${scope} refreshes (expires in ${duration(lastChance.msLeft)})`,
        };
      }
      if (weekly.msLeft < WAIT_SOON || (weekly.msLeft < CREDIT_SOON && resets === 1)) {
        return {
          kind: "wait",
          level: "pace",
          text: `Save the reset: Wait for ${scope} reset in ${duration(weekly.msLeft)}`,
        };
      }
      return {
        kind: "reset",
        level: "reset",
        text: weekly.remaining > 0
          ? `Use up remaining ${scope} (${Math.round(weekly.remaining)}% left), then use a reset`
          : "Use a reset",
      };
    }
    return {
      kind: "pace",
      level: "tight",
      text: weekly.remaining > 0
        ? `Stay steady on ${scope} (${Math.round(weekly.remaining)}% left · resets in ${duration(weekly.msLeft)})`
        : `Wait for ${scope} reset in ${duration(weekly.msLeft)}`,
    };
  }
  if (session && Number.isFinite(session.msLeft) && session.msLeft > 0 && session.remaining <= 10) {
    return suggestionForSessionLock(session, planResets, weekly);
  }
  if (resets > 0) {
    if (directExpiring) {
      return {
        kind: "reset",
        level: "reset",
        text: `Use up remaining ${scope} (${Math.round(weekly.remaining)}% left), then use a reset (expires in ${duration(directExpiring.msLeft)})`,
      };
    }
    return {
      kind: "reset",
      level: "untapped",
      text: weekly.level === "pace"
        ? `Aggressively use; you are on pace ${scope === "weekly" ? "weekly" : `on ${scope}`} but you have ${resetNoun} available`
        : `Aggressively use; ${scope} is untapped and you have ${resetNoun} available`,
    };
  }
  if (weekly.level === "untapped") {
    return { kind: "use", level: "untapped", text: `Untapped: use remaining ${scope} allowance` };
  }
  return { kind: "pace", level: "pace", text: "On pace" };
}

function suggestionForWindows(rawWindows, planResets, resetNoun, now) {
  const resets = planResets.reduce((sum, entry) => sum + entry.count, 0);
  if (rawWindows.length === 0 && resets === 0) return null;
  const lit = rawWindows.map((w) => ({ ...w, ...light({ ...w, now }) }));
  const lockedSession = lit.find((w) => w.length === 5 * HOUR && Number.isFinite(w.msLeft) && w.msLeft > 0 && w.remaining <= 10);
  if (lockedSession) {
    return suggestionForSessionLock(lockedSession, planResets);
  }
  if (resets > 0) {
    return { kind: "reset", level: "untapped", text: `Aggressively use; you have ${resetNoun} available` };
  }
  if (lit.some((w) => w.level === "tight")) {
    return { kind: "pace", level: "tight", text: "Stay steady on allowance" };
  }
  if (lit.some((w) => w.level === "untapped" && Number.isFinite(w.msLeft) && w.msLeft > 0)) {
    return { kind: "use", level: "untapped", text: "Untapped: use remaining allowance" };
  }
  return { kind: "pace", level: "pace", text: "On pace" };
}

/**
 * Per-provider suggestion shown at the bottom of each coding agent's allowance card, following
 * the three guiding rules:
 * 1. 7D nearly all used up, < 2 days left, reset available -> save the reset and wait for weekly reset.
 * 2. 7D nearly all used up, > 3 days left, reset available -> use up remaining weekly, then use a reset.
 * 3. Otherwise -> if resets are available while on pace/untapped, use aggressively; without resets, stay steady / on pace.
 * For Antigravity, returns a suggestion per model group (e.g. Gemini vs Claude & GPT).
 */
export function providerSuggestion(report, id, now = Date.now()) {
  const planResets = planResetsFor(report, id, now);
  const resets = planResets.reduce((sum, entry) => sum + entry.count, 0);
  const resetNoun = `${resets} reset${resets === 1 ? "" : "s"}`;

  if (id === "antigravity" || id === "Antigravity") {
    const groups = report?.antigravity?.groups ?? [];
    const results = groups.map((group) => {
      const weekly = weeklyFor(report, "antigravity", group.name, now);
      const session = sessionFor(report, "antigravity", group.name, now);
      const base = weekly && Number.isFinite(weekly.msLeft) && weekly.msLeft > 0
        ? suggestionForWeekly(weekly, session, [], resetNoun)
        : suggestionForWindows((group.buckets ?? []).map((b) => ({
          remaining: b.remaining_percent, resetsAt: b.resets_at, length: windowLength(b.label),
        })), [], resetNoun, now);
      return base ? { group: group.name, ...base } : null;
    }).filter(Boolean);
    return results.length ? results : null;
  }

  const weekly = weeklyFor(report, id, null, now);
  const session = sessionFor(report, id, null, now);
  if (weekly && Number.isFinite(weekly.msLeft) && weekly.msLeft > 0) {
    return suggestionForWeekly(weekly, session, planResets, resetNoun);
  }

  const rawWindows = id === "claude" || id === "codex"
    ? (report?.[id]?.windows ?? []).map((w) => ({
      remaining: 100 - Math.round(w.used_percent), resetsAt: w.resets_at, length: windowLength(w.label),
    }))
    : ((report?.others ?? []).find((p) => p.id === id)?.windows ?? []).map((w) => ({
      remaining: 100 - Math.round(w.used_percent), resetsAt: w.resets_at, length: windowLength(w.kind),
    }));

  return suggestionForWindows(rawWindows, planResets, resetNoun, now);
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
      : entry.urgent === "lowWeekly" ? "Weekly is low · consider using a reset"
      : entry.urgent === "expiring" ? "Use it or lose it"
      : entry.urgent === "lastWeek" ? "Last week to use it"
      : entry.needsLimit ? "Use it at a limit" : "");
  const expires = Number.isFinite(entry.msLeft) ? `expires in ${duration(entry.msLeft)}` : "";
  return [why, expires].filter(Boolean).join(" · ");
}
