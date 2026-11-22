import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FullReport } from "./fetcher.ts";
import { BUCKETS, KEEP_MS, burndowns, readHistory, recordHistory, recordReport, recentReadings, runs, samplesFrom, type Entry } from "./history.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const tempFile = () => join(mkdtempSync(join(tmpdir(), "usage-history-")), "history.jsonl");

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
    expect(samplesFrom(report)).toEqual([
      { p: "claude", w: "5h session", left: 80, reset: iso(NOW + HOUR) },
      { p: "claude", w: "7d Opus", left: 66.7, reset: null },
      { p: "codex", w: "Weekly", left: 95, reset: null },
      { p: "antigravity", g: "Gemini", w: "5h limit", left: 90, reset: null },
      { p: "cursor", g: "gpt", w: "month", left: 50, reset: null },
    ]);
  });
});

describe("recordHistory", () => {
  test("appends one line per read and reads them back in order", () => {
    const file = tempFile();
    recordHistory([{ p: "claude", w: "5h session", left: 90, reset: null }], NOW, file);
    recordHistory([{ p: "claude", w: "5h session", left: 80, reset: null }], NOW + MINUTE, file);
    recordHistory([], NOW + 2 * MINUTE, file);
    expect(readHistory(file).map((e) => e.s[0]!.left)).toEqual([90, 80]);
  });

  test("drops entries past the keeping period once the oldest is a day beyond it", () => {
    const file = tempFile();
    const sample = { p: "claude", w: "5h session", left: 50, reset: null };
    writeFileSync(file, [
      JSON.stringify({ t: NOW - KEEP_MS - 2 * DAY, s: [sample] }),
      "not json",
      JSON.stringify({ t: NOW - DAY, s: [sample] }),
    ].join("\n") + "\n");
    recordHistory([sample], NOW, file);
    expect(readHistory(file).map((e) => e.t)).toEqual([NOW - DAY, NOW]);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("leaves the file alone while the oldest entry is within a day of the limit", () => {
    const file = tempFile();
    const sample = { p: "claude", w: "5h session", left: 50, reset: null };
    writeFileSync(file, JSON.stringify({ t: NOW - KEEP_MS - HOUR, s: [sample] }) + "\n");
    recordHistory([sample], NOW, file);
    expect(readHistory(file)).toHaveLength(2);
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
    recordReport(report({ claude: NOW - 2 * MINUTE, codex: NOW }), file);
    expect(readHistory(file).map((e) => [e.t, e.s.map((s) => s.p)]))
      .toEqual([[NOW - 2 * MINUTE, ["claude"]], [NOW, ["codex"]]]);
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

  test("leaves readings older than the end of a long file alone", () => {
    const file = tempFile();
    const line = JSON.stringify({ t: NOW, s: [{ p: "codex", w: "Weekly", left: 50, reset: null }] });
    writeFileSync(file, `${line}\n`.repeat(4000));
    expect(recentReadings(file).since).toBe(NOW);
    recordReport(report({ claude: NOW - HOUR }), file);
    expect(readHistory(file)).toHaveLength(4000);
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

  test("ends a window with no reset time at now", () => {
    const charts = burndowns([entry(NOW - HOUR, { p: "claude", w: "5h session", left: 100, reset: null })], NOW);
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
});
