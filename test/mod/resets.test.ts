import { expect, test } from "bun:test";
import { adviseUntapped, heldResets, providerDetail, resetNote } from "../../herdr-app/mods/usage-monitor/pace.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-11-24T09:26:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();

// A window `elapsed` of the way through its length, with `left` % remaining.
const window = (label: string, length: number, elapsed: number, left: number) =>
  ({ label, used_percent: 100 - left, resets_at: at(length * (1 - elapsed)) });

const claudeReset = (expiresIn: number, extra: Record<string, unknown> = {}) => ({
  id: "full", label: "One full limit reset", left: 1, total: 1, expires_at: at(expiresIn),
  usable_now: true, paused: false, needs_limit: false, ...extra,
});

test("a held reset is quiet while limits are fine and it outlives this week", () => {
  const [entry] = heldResets({
    claude: { windows: [window("5h session", 5 * HOUR, 0.5, 60), window("7d weekly", 7 * DAY, 0.5, 60)],
      limit_resets: [claudeReset(15 * DAY)] },
  }, now);
  expect(entry).toMatchObject({ provider: "claude", count: 1, usable: true, urgent: null, command: "/limit-reset" });
  expect(resetNote(entry)).toBe("expires in 15d 0h");
});

test("a tight limit makes a held reset pressing, naming the limit", () => {
  const [entry] = heldResets({
    claude: { windows: [window("7d weekly", 7 * DAY, 0.5, 60), window("7d Opus", 7 * DAY, 0.5, 8)],
      limit_resets: [claudeReset(15 * DAY)] },
  }, now);
  expect(entry).toMatchObject({ urgent: "tight", tightLimit: "7d Opus" });
  expect(resetNote(entry)).toBe("7d Opus is tight · expires in 15d 0h");
});

test("a reset expiring within 3 days is use-it-or-lose-it", () => {
  const [entry] = heldResets({
    codex: { windows: [window("Weekly", 7 * DAY, 0.1, 95)],
      resets: { available: 1, items: [{ title: "Full reset", expires_at: at(2 * DAY) }] } },
  }, now);
  expect(entry.urgent).toBe("expiring");
  expect(resetNote(entry)).toBe("Use it or lose it · expires in 2d 0h");
});

test("a reset expiring before the weekly limit resets is in its last week", () => {
  const weekly = window("Weekly", 7 * DAY, 0.1, 95); // resets in about 6.3 days
  const [entry] = heldResets({
    codex: { windows: [weekly], resets: { available: 1, items: [{ title: "Full reset", expires_at: at(5 * DAY) }] } },
  }, now);
  expect(entry.urgent).toBe("lastWeek");
  // Without a weekly limit to compare with, the same reset isn't pressing.
  const [alone] = heldResets({
    codex: { windows: [], resets: { available: 1, items: [{ title: "Full reset", expires_at: at(5 * DAY) }] } },
  }, now);
  expect(alone.urgent).toBeNull();
});

test("a paused reset is listed but never pressing", () => {
  const [entry] = heldResets({
    claude: { windows: [window("7d Opus", 7 * DAY, 0.5, 5)], limit_resets: [claudeReset(DAY, { paused: true })] },
  }, now);
  expect(entry).toMatchObject({ usable: false, urgent: null, status: "Paused" });
  expect(resetNote(entry)).toBe("Paused · expires in 24h 0m");
});

test("pressing resets come first, then the soonest to expire; expired ones are dropped", () => {
  const held = heldResets({
    claude: { windows: [window("7d weekly", 7 * DAY, 0.2, 90)], limit_resets: [claudeReset(20 * DAY)] },
    codex: {
      windows: [window("Weekly", 7 * DAY, 0.2, 90)],
      resets: { available: 3, items: [
        { title: "Old", expires_at: at(-HOUR) },
        { title: "Soon", expires_at: at(DAY) },
        { title: "Later", expires_at: at(10 * DAY) },
      ] },
    },
  }, now);
  expect(held.map((entry) => entry.label)).toEqual(["Soon", "Later", "One full limit reset"]);
});

test("credits Codex counts but doesn't detail are held too", () => {
  const held = heldResets({ codex: { windows: [], resets: { available: 2, items: [] } } }, now);
  expect(held).toEqual([expect.objectContaining({ provider: "codex", label: "Reset credit", count: 2, msLeft: null })]);
});

test("a report without resets holds none", () => {
  expect(heldResets(undefined, now)).toEqual([]);
  expect(heldResets({ claude: { windows: [], limit_resets: [] }, codex: { windows: [], resets: { available: 0, items: [] } } }, now))
    .toEqual([]);
});

test("a provider's hover names only that provider: its limits, then its resets", () => {
  const report = {
    claude: { windows: [window("5h session", 5 * HOUR, 0.5, 62), window("7d weekly", 7 * DAY, 0.5, 38)],
      limit_resets: [claudeReset(15 * DAY)] },
    codex: { windows: [window("Weekly", 7 * DAY, 0.5, 5)],
      resets: { available: 2, items: [{ title: "Full reset", expires_at: at(6 * DAY) }, { title: "Full reset", expires_at: at(17 * DAY) }] } },
  };
  expect(providerDetail(report, "claude", "Claude", now)).toBe([
    "Claude",
    "5h session: 62% left · resets in 2h 30m",
    "7d weekly: 38% left · resets in 3d 12h",
    "",
    "Resets you hold",
    "One full limit reset · expires in 15d 0h · run /limit-reset",
  ].join("\n"));
  const codex = providerDetail(report, "codex", "Codex", now);
  expect(codex).not.toContain("Claude");
  expect(codex.split("\n").filter((line) => line.startsWith("Full reset"))).toEqual([
    "Full reset · Weekly is tight · expires in 6d 0h",
    "Full reset · Weekly is tight · expires in 17d 0h",
  ]);
});

test("Antigravity's hover lists each group's limits, and a limit with no window shows no reset", () => {
  const report = { antigravity: { groups: [{ name: "Gemini models", buckets: [
    { label: "5h limit", remaining_percent: 64, resets_at: at(3 * HOUR) },
    { label: "Weekly limit", remaining_percent: 100, resets_at: "1970-01-01T00:00:00Z" },
  ] }] } };
  expect(providerDetail(report, "antigravity", "Antigravity", now)).toBe([
    "Antigravity",
    "Gemini models · 5h limit: 64% left · resets in 3h 0m",
    "Gemini models · Weekly limit: 100% left",
  ].join("\n"));
});

test("smart untapped advises waiting when 5h is high, weekly is low, and reset is soon (< 3d)", () => {
  const report = {
    claude: { windows: [
      { label: "5h session", used_percent: 10, resets_at: at(4 * HOUR) },
      { label: "7d weekly", used_percent: 82, resets_at: at(1.5 * DAY) },
    ] },
  };
  const [advice] = adviseUntapped([
    { provider: "Claude", label: "5h session", group: null, length: 5 * HOUR, remaining: 90, msLeft: 4 * HOUR, spare: 10 },
  ], report, now);
  expect(advice).toMatchObject({ provider: "Claude", kind: "wait", weeklyRemaining: 18 });
  expect(advice.weeklyMsLeft).toBe(1.5 * DAY);
});

test("smart untapped advises using 5h when both weekly and 5h have lots left", () => {
  const report = {
    claude: { windows: [
      { label: "5h session", used_percent: 10, resets_at: at(4 * HOUR) },
      { label: "7d weekly", used_percent: 20, resets_at: at(4 * DAY) },
    ] },
  };
  const [advice] = adviseUntapped([
    { provider: "Claude", label: "5h session", group: null, length: 5 * HOUR, remaining: 90, msLeft: 4 * HOUR, spare: 10 },
  ], report, now);
  expect(advice).toMatchObject({ provider: "Claude", kind: "use" });
});

test("smart untapped and heldResets advise looking towards a reset when weekly is low with 3-4 days left", () => {
  const report = {
    claude: {
      windows: [
        { label: "5h session", used_percent: 10, resets_at: at(4 * HOUR) },
        { label: "7d weekly", used_percent: 72, resets_at: at(3.5 * DAY) },
      ],
      limit_resets: [claudeReset(15 * DAY)],
    },
  };
  const [advice] = adviseUntapped([
    { provider: "Claude", label: "5h session", group: null, length: 5 * HOUR, remaining: 90, msLeft: 4 * HOUR, spare: 10 },
  ], report, now);
  expect(advice).toMatchObject({ provider: "Claude", kind: "reset", weeklyRemaining: 28 });

  const [held] = heldResets({
    claude: {
      windows: [
        { label: "5h session", used_percent: 10, resets_at: at(4 * HOUR) },
        { label: "7d weekly", used_percent: 70, resets_at: at(3.1 * DAY) },
      ],
      limit_resets: [claudeReset(15 * DAY)],
    },
  }, now);
  expect(held.urgent).toBe("lowWeekly");
  expect(resetNote(held)).toContain("Weekly is low · consider using a reset");
});

test("smart untapped ignores expired weekly windows so stale cached resets do not trigger reset advice", () => {
  const report = {
    claude: { windows: [
      { label: "5h session", used_percent: 10, resets_at: at(4 * HOUR) },
      { label: "7d weekly", used_percent: 90, resets_at: at(-60_000) },
    ] },
  };
  const [advice] = adviseUntapped([
    { provider: "Claude", label: "5h session", group: null, length: 5 * HOUR, remaining: 90, msLeft: 4 * HOUR, spare: 10 },
  ], report, now);
  expect(advice).toMatchObject({ provider: "Claude", kind: "use" });
});
