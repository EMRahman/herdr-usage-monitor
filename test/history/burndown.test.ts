import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryDatabase } from "../../src/history/db.ts";
import type { FullReport } from "../../src/fetcher.ts";
import { BUCKETS, accountId, burndowns, labelAccounts, readBurndowns, readHistory, recordReport, runs, samplesFrom, type Entry } from "../../src/history/burndown.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const tempFile = () => join(mkdtempSync(join(tmpdir(), "usage-history-")), "history.sqlite");

describe("samplesFrom", () => {
  test("records every provider's limits as % left", () => {
    const report: FullReport = {
      timestamp: NOW,
      claude: {
        account: "a",
        plan: "max",
        windows: [
          { label: "5h session", used_percent: 20, resets_at: iso(NOW + HOUR) },
          { label: "7d Opus", used_percent: 33.33, resets_at: null },
        ],
      },
      codex: { account: "a", plan: "pro", windows: [{ label: "Weekly", used_percent: 5, resets_at: null }], resets: { available: 0, items: [] } },
      antigravity: { account: "a", groups: [{ name: "Gemini", buckets: [{ label: "5h limit", remaining_percent: 90, resets_at: null }] }] },
      others: [{ id: "cursor", account: "a", plan: null, windows: [{ kind: "month", scope: "gpt", used_percent: 50, resets_at: null }], problem: null }],
    };
    const a = accountId("a");
    expect(samplesFrom(report)).toEqual([
      { p: "claude", a, w: "5h session", left: 80, reset: iso(NOW + HOUR) },
      { p: "claude", a, w: "7d Opus", left: 66.7, reset: null },
      { p: "codex", a, w: "Weekly", left: 95, reset: null },
      { p: "antigravity", a, g: "Gemini", w: "5h limit", left: 90, reset: null },
      { p: "cursor", a, g: "gpt", w: "month", left: 50, reset: null },
    ]);
  });

  test("names accounts by a hash, not the account itself", () => {
    const report: FullReport = {
      timestamp: NOW,
      others: [{ id: "grok", account: "me@example.com", plan: null, windows: [{ kind: "week", scope: null, used_percent: 10, resets_at: null }], problem: null }],
    };
    const [sample] = samplesFrom(report);
    expect(sample!.a).toMatch(/^[0-9a-f]{10}$/);
    expect(JSON.stringify(sample)).not.toContain("example.com");
  });
});

describe("recordReport", () => {
  const report = (readAt: FullReport["read_at"], claude = 80, codex = 60): FullReport => ({
    timestamp: NOW,
    claude: { account: "a", plan: "max", windows: [{ label: "5h session", used_percent: 100 - claude, resets_at: null }] },
    codex: { account: "a", plan: "pro", windows: [{ label: "Weekly", used_percent: 100 - codex, resets_at: null }], resets: { available: 0, items: [] } },
    others: [],
    ...(readAt ? { read_at: readAt } : {}),
  });

  test("stamps each provider with when it was read", () => {
    const file = tempFile();
    const last = NOW - 0.25;
    recordReport(report({ claude: NOW - 2 * MINUTE, codex: last }), file);
    expect(readHistory(file).map((e) => [e.t, e.s.map((s) => s.p)]))
      .toEqual([[NOW - 2 * MINUTE, ["claude"]], [last, ["codex"]]]);
  });

  test("records a reading once, however many times the report is seen", () => {
    const file = tempFile();
    const seen = report({ claude: NOW, codex: NOW });
    recordReport(seen, file);
    recordReport(seen, file);
    expect(readHistory(file)).toHaveLength(1);
  });

  test("skips carried-over figures and keeps the ones read since", () => {
    const file = tempFile();
    recordReport(report({ claude: NOW, codex: NOW }), file);
    // Claude was rate limited: its figures are the earlier ones, carried over.
    recordReport(report({ claude: NOW, codex: NOW + 3 * MINUTE }, 80, 55), file);
    expect(readHistory(file).map((e) => [e.t, e.s.map((s) => `${s.p} ${s.left}`)]))
      .toEqual([[NOW, ["claude 80", "codex 60"]], [NOW + 3 * MINUTE, ["codex 55"]]]);
  });

  test("records nothing from a report without read times", () => {
    const file = tempFile();
    recordReport(report(undefined), file);
    expect(readHistory(file)).toEqual([]);
  });

  test("retains old readings across subsequent writes", () => {
    const file = tempFile();
    const old = NOW - 400 * DAY;
    recordReport(report({ claude: old }), file);
    recordReport(report({ codex: NOW }), file);
    expect(readHistory(file).map((entry) => entry.t)).toEqual([old, NOW]);
    expect(readHistory(file, NOW).map((entry) => entry.t)).toEqual([NOW]);
  });

  test("deduplicates readings from overlapping bridge processes", async () => {
    const file = tempFile();
    const writer = `import { recordReport } from ${JSON.stringify(new URL("../../src/history/burndown.ts", import.meta.url).href)};
      const [file, payload] = process.argv.slice(1);
      recordReport(JSON.parse(payload), file);`;
    const results = await Promise.all([
      report({ claude: NOW - 1, codex: NOW }),
      report({ claude: NOW, codex: NOW }),
    ].map((value) => Bun.spawn([process.execPath, "-e", writer, file, JSON.stringify(value)]).exited));
    expect(results).toEqual([0, 0]);
    const stored = readHistory(file);
    expect(stored.map((entry) => entry.t)).toEqual([NOW - 1, NOW]);
    expect(stored[0]!.s.map((sample) => sample.p)).toEqual(["claude"]);
    expect(stored[1]!.s.map((sample) => sample.p).sort()).toEqual(["claude", "codex"]);
    const db = openHistoryDatabase(file, true);
    try {
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.close();
    }
  });

  test("reads the entire weekly window when its latest reading is a day old", () => {
    const file = tempFile();
    const reset = NOW - DAY;
    const start = reset - 7 * DAY;
    recordReport(report({ codex: start - 1 }, 80, 77), file);
    recordReport(report({ codex: start }, 80, 68), file);
    const latest = report({ codex: reset }, 80, 48);
    latest.codex!.windows[0]!.resets_at = iso(reset);
    recordReport(latest, file);
    const [chart] = readBurndowns(file, NOW);
    expect(chart?.runs.map(([from, , left]) => [from, left])).toEqual([[start, 68], [reset, 48]]);
  });
});

describe("runs", () => {
  const length = 5 * HOUR;
  const slice = length / BUCKETS;

  test("holds each value until the next reading and merges equal neighbours", () => {
    const start = NOW - 2 * HOUR;
    expect(runs([[start, 100], [start + 3 * MINUTE, 100], [start + 6 * MINUTE, 90]], length, start + 9 * MINUTE))
      .toEqual([[start, start + 6 * MINUTE, 100], [start + 6 * MINUTE, start + 9 * MINUTE, 90]]);
  });

  test("breaks the line across a long gap in readings", () => {
    const start = NOW - 3 * HOUR;
    const later = start + HOUR;
    expect(runs([[start, 80], [later, 70]], length, later + 3 * MINUTE))
      .toEqual([[start, start + slice, 80], [later, later + 3 * MINUTE, 70]]);
  });

  test("keeps the last reading in each slice", () => {
    const start = Math.floor(NOW / slice) * slice;
    expect(runs([[start, 90], [start + 10_000, 85]], length, start + 10_000))
      .toEqual([[start + 10_000, start + 10_000, 85]]);
  });
});

describe("burndowns", () => {
  const entry = (t: number, ...s: Entry["s"]): Entry => ({ t, s });

  test("charts the current 5-hour and weekly windows from reset minus length", () => {
    const reset = NOW + 2 * HOUR;
    const weekly = NOW + 3 * DAY;
    const entries = [
      entry(NOW - 4 * HOUR, { p: "claude", w: "5h session", left: 30, reset: iso(NOW - 3.5 * HOUR) }),
      entry(NOW - 2 * HOUR, { p: "claude", w: "5h session", left: 100, reset: iso(reset) },
        { p: "claude", w: "7d weekly", left: 60, reset: iso(weekly) }),
      entry(NOW - 1.95 * HOUR, { p: "claude", w: "5h session", left: 90, reset: iso(reset) },
        { p: "claude", w: "7d weekly", left: 58, reset: iso(weekly) },
        { p: "cursor", w: "month", left: 10, reset: null }),
    ];
    const charts = burndowns(entries, NOW);
    expect(charts.map((c) => c.label)).toEqual(["5h session", "7d weekly"]);
    const [session] = charts;
    expect(session!.start).toBe(reset - 5 * HOUR);
    expect(session!.end).toBe(reset);
    expect(session!.left).toBe(90);
    // The reading from the previous window is left out.
    expect(session!.runs[0]![2]).toBe(100);
  });

  test("keeps two accounts of one provider apart and names them", () => {
    const [one, two] = [accountId("one@example.com")!, accountId("two@example.com")!];
    const entries = [
      entry(NOW - 2 * HOUR, { p: "grok", a: one, w: "week", left: 90, reset: null }, { p: "grok", a: two, w: "week", left: 40, reset: null }),
      entry(NOW - HOUR, { p: "grok", a: one, w: "week", left: 85, reset: null }, { p: "grok", a: two, w: "week", left: 30, reset: null }),
    ];
    const charts = burndowns(entries, NOW);
    expect(charts.map((c) => [c.account, c.left])).toEqual([[one, 85], [two, 30]]);
    const names = new Map([[one, "one@example.com"]]);
    expect(labelAccounts(charts, names).map((c) => c.accountLabel)).toEqual(["one@example.com", "Another account"]);
  });

  test("leaves a provider with one account unnamed", () => {
    const a = accountId("me")!;
    const charts = burndowns([entry(NOW - HOUR, { p: "claude", a, w: "5h session", left: 50, reset: null })], NOW);
    expect(labelAccounts(charts, new Map([[a, "me"]]))[0]!.accountLabel).toBeUndefined();
  });

  test("joins readings saved before accounts were kept to the limit's only account", () => {
    const a = accountId("me")!;
    const charts = burndowns([
      entry(NOW - 2 * HOUR, { p: "claude", w: "5h session", left: 90, reset: null }),
      entry(NOW - 2 * HOUR + 3 * MINUTE, { p: "claude", a, w: "5h session", left: 80, reset: null }),
    ], NOW);
    expect(charts).toHaveLength(1);
    expect(charts[0]!.runs.map((r) => r[2])).toEqual([90, 80]);
  });

  test("pins a full (100%) window with no reset time to the left starting at now", () => {
    const charts = burndowns([
      entry(NOW - 2 * HOUR, { p: "claude", w: "5h session", left: 40, reset: iso(NOW - HOUR) }),
      entry(NOW - 5 * MINUTE, { p: "claude", w: "5h session", left: 100, reset: null }),
    ], NOW);
    expect(charts[0]!.start).toBe(NOW);
    expect(charts[0]!.end).toBe(NOW + 5 * HOUR);
    expect(charts[0]!.runs).toEqual([[NOW, NOW, 100]]);
  });

  test("ends a partially used window with no reset time at now", () => {
    const charts = burndowns([entry(NOW - HOUR, { p: "claude", w: "5h session", left: 80, reset: null })], NOW);
    expect(charts[0]!.end).toBe(NOW);
    expect(charts[0]!.start).toBe(NOW - 5 * HOUR);
  });

  test("keeps model groups apart and drops limits not read in a day", () => {
    const entries = [
      entry(NOW - 2 * DAY, { p: "codex", w: "Weekly", left: 50, reset: null }),
      entry(NOW - HOUR,
        { p: "antigravity", g: "Gemini", w: "5h limit", left: 80, reset: null },
        { p: "antigravity", g: "Claude & GPT", w: "5h limit", left: 40, reset: null }),
    ];
    expect(burndowns(entries, NOW).map((c) => [c.group, c.left])).toEqual([["Gemini", 80], ["Claude & GPT", 40]]);
  });

  test("drops a model group its provider no longer reports", () => {
    const entries = [
      entry(NOW - 3 * HOUR,
        { p: "antigravity", g: "Gemini", w: "Weekly Limit Remaining", left: 90, reset: null },
        { p: "antigravity", g: "Gemini 4 Argon", w: "Gemini 4 Argon Weekly Limit", left: 60, reset: null }),
      entry(NOW - HOUR, { p: "antigravity", g: "Gemini", w: "Weekly Limit Remaining", left: 85, reset: null }),
      entry(NOW - 2 * HOUR, { p: "codex", w: "Weekly", left: 50, reset: null }),
    ];
    expect(burndowns(entries, NOW).map((c) => [c.provider, c.group])).toEqual([["antigravity", "Gemini"], ["codex", undefined]]);
  });

  test("keeps a provider's separate limits of one length apart", () => {
    const charts = burndowns([entry(NOW - HOUR,
      { p: "claude", w: "7d weekly", left: 10, reset: null },
      { p: "claude", w: "7d Sonnet", left: 80, reset: null })], NOW);
    expect(charts.map((c) => [c.label, c.left])).toEqual([["7d weekly", 10], ["7d Sonnet", 80]]);
  });

  test("charts one limit read under two labels as one window", () => {
    const reset = new Date(NOW + 4 * HOUR).toISOString();
    const entries = [
      entry(NOW - 4 * HOUR, { p: "antigravity", g: "Claude", w: "5h limit", left: 100, reset: new Date(NOW + HOUR).toISOString() }),
      entry(NOW - 2 * HOUR, { p: "antigravity", g: "Claude", w: "Weekly limit", left: 60, reset: null }),
      entry(NOW - 30 * MINUTE, { p: "antigravity", g: "Claude", w: "Five Hour Limit Remaining", left: 90, reset }),
      entry(NOW - 10 * MINUTE, { p: "antigravity", g: "Claude", w: "Five Hour Limit Remaining", left: 70, reset },
        { p: "antigravity", g: "Claude", w: "Weekly Limit Remaining", left: 55, reset: null }),
    ];
    const charts = burndowns(entries, NOW);
    expect(charts.map((c) => [c.label, c.left])).toEqual([["Five Hour Limit Remaining", 70], ["Weekly Limit Remaining", 55]]);
    expect(charts[0]!.end).toBe(NOW + 4 * HOUR);
  });

  test("treats a full limit with a reset rolling a window ahead as not started", () => {
    const reset = new Date(NOW - 10 * MINUTE + 5 * HOUR + 3_000).toISOString();
    const [chart] = burndowns([entry(NOW - 10 * MINUTE, { p: "antigravity", g: "Claude", w: "5h limit", left: 100, reset })], NOW);
    expect(chart!.reset).toBeNull();
    expect(chart!.start).toBe(NOW);
  });
});
