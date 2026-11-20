// Traffic lights for allowance windows: is capacity going unused before it resets?
//
// A window resets on a clock. If you used it evenly, the share left would match the share of
// time left. More allowance left than time left means you're under pace: at this rate some of it
// resets unused ("untapped"). Much less means you'll run out before the reset ("tight").

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Spare or short by this many points (allowance % minus time %) changes the light.
export const MARGIN = 20;
// Reset credits expiring this soon are worth using now.
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

/** Reset credits: untapped when one expires soon, otherwise nothing to flag. */
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
