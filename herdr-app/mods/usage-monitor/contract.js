// The readings other mods may use: Usage Monitor publishes every pool's windows as shared state
// "usage-monitor.windows", and keeps reading while a mod is registered in
// "usage-monitor.consumers". Usage Queue is the first such mod.
//
// Raw numbers, not verdicts: a consumer judges pace from leftPct, resetsAt and lengthMs itself.
// `light` is for display only.
//
// Pure: no Herdr imports, so `bun test` runs it.

import { light, windowLength } from "./pace.js";

export const WINDOWS_KEY = "usage-monitor.windows";
export const CONSUMERS_KEY = "usage-monitor.consumers";
export const CONTRACT_VERSION = 1;
/** A consumer that hasn't checked in for this long is gone. Consumers check in every minute. */
export const CONSUMER_TTL_MS = 3 * 60_000;

const LIGHTS = { untapped: "untapped", pace: "on-pace", tight: "tight" };

/** A window's kind from its label or a provider's kind word ("5h session", "Weekly",
 *  "Five Hour Limit Remaining", "week", "month"). */
export function windowKind(text) {
  const s = String(text ?? "").toLowerCase();
  if (/\b5\s*h\b|five[\s-]hour/.test(s)) return "5h";
  if (/\b7\s*d\b|week/.test(s)) return "weekly";
  if (/\b24\s*h\b|\bday\b|daily/.test(s)) return "daily";
  if (/month/.test(s)) return "monthly";
  return "other";
}

const finite = (value) => (Number.isFinite(value) ? value : null);
/** A percentage figure: null or "" is no figure, not 0. */
const isPct = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function contractWindow(label, leftPct, resetsAt, kindText, now) {
  const left = Math.max(0, Math.min(100, Number(leftPct)));
  const reset = Date.parse(resetsAt ?? "");
  const lengthMs = windowLength(kindText);
  return {
    kind: windowKind(kindText),
    label: String(label || kindText || "Limit"),
    leftPct: left,
    resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
    lengthMs,
    light: LIGHTS[light({ remaining: left, resetsAt, length: lengthMs, now }).level] ?? null,
  };
}

const usedWindows = (list, now) => (list ?? [])
  .filter((w) => isPct(w?.used_percent))
  .map((w) => contractWindow(w.label, 100 - Number(w.used_percent), w.resets_at, w.label, now));

function claudeResets(claude) {
  return (claude.limit_resets ?? []).map((reset, i) => ({
    id: String(reset.id ?? `reset-${i + 1}`),
    label: String(reset.label ?? "Limit reset"),
    count: reset.left ?? 1,
    expiresAt: reset.expires_at ?? null,
    usableNow: !reset.paused && reset.usable_now !== false,
  }));
}

function codexResets(codex) {
  const items = codex.resets?.items ?? [];
  const held = items.map((item, i) => ({
    id: String(item.id ?? `credit-${i + 1}`),
    label: String(item.title || "Reset credit"),
    count: 1,
    expiresAt: item.expires_at ?? null,
    usableNow: true,
  }));
  // Credits Codex counted but didn't detail.
  const undetailed = (codex.resets?.available ?? 0) - items.length;
  if (undetailed > 0) held.push({ id: "credits", label: "Reset credit", count: undetailed, expiresAt: null, usableNow: true });
  return held;
}

/**
 * The published readings from a bridge report: one pool per set of windows a run draws on (a
 * provider account, or an Antigravity model group). `checkedAt` is when Usage Monitor last read
 * the bridge, so a consumer can tell whether anyone is still publishing.
 */
export function windowsContract(report, now = Date.now(), checkedAt = now) {
  const pools = [];
  if (report && typeof report === "object") {
    const readAt = (key) => finite(report.read_at?.[key]) ?? finite(report.timestamp);
    const ttlMs = (key) => finite(report.ttl?.[key]) ?? finite(report.ttl?.others);
    const common = (key, p) => ({
      provider: key, account: p.account || null, plan: p.plan || null, readAt: readAt(key), ttlMs: ttlMs(key),
    });

    if (report.claude?.windows) {
      pools.push({ id: "claude", ...common("claude", report.claude), windows: usedWindows(report.claude.windows, now),
        heldResets: claudeResets(report.claude) });
    }
    if (report.codex?.windows) {
      pools.push({ id: "codex", ...common("codex", report.codex), windows: usedWindows(report.codex.windows, now),
        heldResets: codexResets(report.codex) });
    }
    const agy = report.antigravity;
    for (const group of agy?.groups ?? []) {
      pools.push({
        id: `antigravity/${slug(group.name)}`, ...common("antigravity", { account: agy.account, plan: agy.tier }),
        name: group.name,
        models: String(group.models ?? "").split(",").map((m) => m.trim()).filter(Boolean),
        windows: (group.buckets ?? [])
          .filter((b) => isPct(b?.remaining_percent))
          .map((b) => contractWindow(b.label, Number(b.remaining_percent), b.resets_at, b.label, now)),
      });
    }
    for (const p of report.others ?? []) {
      if (!p?.id || !Array.isArray(p.windows)) continue;
      pools.push({
        id: p.id, ...common(p.id, p),
        windows: p.windows
          .filter((w) => isPct(w?.used_percent))
          .map((w) => contractWindow([w.kind, w.scope].filter(Boolean).join(" · "), 100 - Number(w.used_percent),
            w.resets_at, w.kind, now)),
        heldResets: p.resets?.available > 0
          ? [{ id: "credits", label: "Reset credits", count: p.resets.available, expiresAt: p.resets.expires_at ?? null, usableNow: true }]
          : [],
      });
    }
  }
  const times = pools.map((p) => p.readAt).filter((t) => t !== null);
  return {
    version: CONTRACT_VERSION,
    readAt: times.length ? Math.max(...times) : finite(report?.timestamp) ?? 0,
    checkedAt,
    pools,
  };
}

/** Whether any mod registered in "usage-monitor.consumers" ({ [id]: last check-in, ms }) is
 *  still checking in. */
export function hasConsumers(consumers, now = Date.now()) {
  if (!consumers || typeof consumers !== "object") return false;
  return Object.values(consumers).some((at) => Number.isFinite(at) && now - at < CONSUMER_TTL_MS);
}
