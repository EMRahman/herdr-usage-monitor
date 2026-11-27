import { describe, expect, test } from "bun:test";
import { CONSUMER_TTL_MS, hasConsumers, windowKind, windowsContract } from "../../herdr-app/mods/usage-monitor/contract.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Usage Queue's design example: 2026-11-26 22:52 UTC.
const now = Date.parse("2026-11-26T22:52:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();

const REPORT = {
  timestamp: now,
  claude: {
    account: "me@example.com",
    plan: "pro",
    windows: [
      { label: "5h session", used_percent: 9, resets_at: at(4.1 * HOUR) },
      { label: "7d weekly", used_percent: 96, resets_at: at(4.1 * HOUR) },
    ],
    limit_resets: [{ id: "full", label: "One full limit reset", left: 1, total: 1, expires_at: at(14 * DAY),
      usable_now: true, paused: false, needs_limit: false }],
  },
  codex: {
    account: "me@example.com",
    plan: "plus",
    windows: [
      { label: "5h session", used_percent: 100, resets_at: at(1.6 * HOUR) },
      { label: "Weekly", used_percent: 46, resets_at: at(5.7 * DAY) },
    ],
    resets: { available: 2, items: [{ id: "c1", title: "Reset credit", status: "ok", granted_at: at(-DAY), expires_at: at(9 * DAY) }] },
  },
  antigravity: {
    account: "default",
    groups: [
      {
        name: "Gemini Models", models: "Gemini 4 Neon, Gemini 3.8 Flash",
        buckets: [
          { label: "Weekly Limit Remaining", remaining_percent: 68, resets_at: at(6.4 * DAY) },
          { label: "Five Hour Limit Remaining", remaining_percent: 74, resets_at: at(1.4 * HOUR) },
        ],
      },
    ],
  },
  others: [
    { id: "cursor", account: "me", plan: "pro", problem: null,
      windows: [{ kind: "month", scope: "Auto", used_percent: 30, resets_at: at(10 * DAY) },
        { kind: "month", scope: "Credits", used_percent: null, resets_at: null }] },
    { id: "copilot", account: "me", plan: null, problem: "expired", windows: [] },
  ],
  read_at: { claude: now - 60_000, codex: now - 120_000, antigravity: now },
  ttl: { claude: 180_000, codex: 3_600_000, antigravity: 3_600_000, others: 900_000 },
};

describe("windowsContract", () => {
  const contract = windowsContract(REPORT, now, now + 1);
  const pool = (id: string) => contract.pools.find((p: { id: string }) => p.id === id);

  test("versioned, with the newest reading and when it was checked", () => {
    expect(contract.version).toBe(1);
    expect(contract.readAt).toBe(now);
    expect(contract.checkedAt).toBe(now + 1);
    expect(contract.pools.map((p: { id: string }) => p.id))
      .toEqual(["claude", "codex", "antigravity/gemini-models", "cursor", "copilot"]);
  });

  test("windows carry % left, the reset as ISO, length and kind", () => {
    expect(pool("claude")).toMatchObject({
      provider: "claude", account: "me@example.com", plan: "pro", readAt: now - 60_000, ttlMs: 180_000,
    });
    expect(pool("claude").windows).toEqual([
      { kind: "5h", label: "5h session", leftPct: 91, resetsAt: at(4.1 * HOUR), lengthMs: 5 * HOUR, light: "on-pace" },
      { kind: "weekly", label: "7d weekly", leftPct: 4, resetsAt: at(4.1 * HOUR), lengthMs: 7 * DAY, light: "tight" },
    ]);
  });

  test("an Antigravity model group is its own pool, with its models", () => {
    const gemini = pool("antigravity/gemini-models");
    expect(gemini).toMatchObject({ provider: "antigravity", account: "default", models: ["Gemini 4 Neon", "Gemini 3.8 Flash"] });
    expect(gemini.windows.map((w: { kind: string; leftPct: number; light: string }) => [w.kind, w.leftPct, w.light]))
      .toEqual([["weekly", 68, "tight"], ["5h", 74, "untapped"]]);
  });

  test("other providers name their window by kind and scope; a provider with a problem has none", () => {
    expect(pool("cursor").windows[0]).toMatchObject({ kind: "monthly", label: "month · Auto", leftPct: 70, lengthMs: 30 * DAY });
    expect(pool("cursor").windows).toHaveLength(1);
    expect(pool("cursor").ttlMs).toBe(900_000);
    // Not in read_at: carried over from an older report, so its age is unknown.
    expect(pool("cursor").readAt).toBeNull();
    expect(pool("copilot").windows).toEqual([]);
  });

  test("held resets: Claude's grants and Codex's credits, detailed or counted", () => {
    expect(pool("claude").heldResets).toEqual([
      { id: "full", label: "One full limit reset", count: 1, expiresAt: at(14 * DAY), usableNow: true },
    ]);
    expect(pool("codex").heldResets).toEqual([
      { id: "c1", label: "Reset credit", count: 1, expiresAt: at(9 * DAY), usableNow: true },
      { id: "credits", label: "Reset credit", count: 1, expiresAt: null, usableNow: true },
    ]);
  });

  test("a report without read_at falls back to when it was saved", () => {
    const { read_at: _, ...legacy } = REPORT;
    expect(pool("claude").readAt).toBe(now - 60_000);
    expect(windowsContract({ ...legacy, timestamp: now - HOUR }, now).pools.map((p: { readAt: number }) => p.readAt))
      .toEqual([now - HOUR, now - HOUR, now - HOUR, now - HOUR, now - HOUR]);
  });

  test("no report: no pools", () => {
    expect(windowsContract(null, now)).toEqual({ version: 1, readAt: 0, checkedAt: now, pools: [] });
  });
});

test("windowKind reads the providers' labels", () => {
  expect(windowKind("Five Hour Limit Remaining")).toBe("5h");
  expect(windowKind("Weekly Limit Remaining")).toBe("weekly");
  expect(windowKind("7d Opus")).toBe("weekly");
  expect(windowKind("credits")).toBe("other");
});

test("hasConsumers: only consumers that checked in lately", () => {
  expect(hasConsumers(undefined, now)).toBe(false);
  expect(hasConsumers({}, now)).toBe(false);
  expect(hasConsumers({ "usage-queue": now - 30_000 }, now)).toBe(true);
  expect(hasConsumers({ "usage-queue": now - CONSUMER_TTL_MS }, now)).toBe(false);
  expect(hasConsumers({ "usage-queue": null, other: now }, now)).toBe(true);
});
