// Allowance history kept on this machine for the burndown charts.
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { historyFile, openHistoryDatabase } from "./db.ts";
import type { FullReport } from "../fetcher.ts";
import { windowLength } from "../../herdr-app/mods/usage-monitor/pace.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Charts draw this many steps across a window at most.
export const BUCKETS = 180;

/** One limit at one moment. p: provider id; a: the account, as accountId; g: model group or
 *  scope, when the provider splits a limit by model; w: the limit's label; left: % left;
 *  reset: when it resets, if known. */
export interface Sample {
  p: string;
  a?: string;
  g?: string;
  w: string;
  left: number;
  reset: string | null;
}

export interface Entry {
  t: number;
  s: Sample[];
}

/** One limit's current window: [from, to, % left] runs of a step line. A break between runs
 *  (from ≠ the previous run's to) is time with no readings, drawn as a gap. */
export interface Burndown {
  provider: string;
  account?: string;
  /** The account's name, added by the bridge when a provider has more than one account. */
  accountLabel?: string;
  group?: string;
  label: string;
  length: number;
  start: number;
  end: number;
  left: number;
  reset: string | null;
  runs: Array<[number, number, number]>;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** A stable stand-in for an account (often an email), so the history keeps each account's
 *  readings apart without naming it. */
export function accountId(account: string | null | undefined): string | undefined {
  return account ? createHash("sha256").update(account).digest("hex").slice(0, 10) : undefined;
}

/** Each account in a report by its accountId, for naming charts. */
export function accountNames(report: FullReport | null | undefined): Map<string, string> {
  const names = new Map<string, string>();
  for (const provider of [report?.claude, report?.codex, report?.antigravity, ...(report?.others ?? [])]) {
    const id = accountId(provider?.account);
    if (id) names.set(id, provider!.account);
  }
  return names;
}

/** Names the accounts of providers that have more than one, so their charts can be told apart. */
export function labelAccounts(charts: Burndown[], names: Map<string, string>): Burndown[] {
  const accounts = new Map<string, Set<string | undefined>>();
  for (const b of charts) {
    if (!accounts.has(b.provider)) accounts.set(b.provider, new Set());
    accounts.get(b.provider)!.add(b.account);
  }
  return charts.map((b) => {
    if ((accounts.get(b.provider)?.size ?? 0) < 2) return b;
    return { ...b, accountLabel: (b.account && names.get(b.account)) || "Another account" };
  });
}

/** Every limit in a report, as samples. A report can carry older figures for a provider that
 *  wasn't read this time; recordReport uses read_at to tell them apart. */
export function samplesFrom(report: FullReport): Sample[] {
  const samples: Sample[] = [];
  const add = (p: string, account: string | undefined, sample: Omit<Sample, "p" | "a">) => {
    const a = accountId(account);
    samples.push({ p, ...(a ? { a } : {}), ...sample });
  };
  for (const [id, provider] of [["claude", report.claude], ["codex", report.codex]] as const) {
    for (const w of provider?.windows ?? []) {
      add(id, provider!.account, { w: w.label, left: round(100 - w.used_percent), reset: w.resets_at ?? null });
    }
  }
  for (const group of report.antigravity?.groups ?? []) {
    for (const b of group.buckets ?? []) {
      add("antigravity", report.antigravity!.account, { g: group.name, w: b.label, left: round(b.remaining_percent), reset: b.resets_at ?? null });
    }
  }
  for (const provider of report.others ?? []) {
    for (const w of provider.windows ?? []) {
      add(provider.id, provider.account, {
        ...(w.scope ? { g: w.scope } : {}),
        w: w.kind,
        left: round(100 - w.used_percent),
        reset: w.resets_at ?? null,
      });
    }
  }
  return samples.filter((s) => Number.isFinite(s.left));
}

/** Store each provider read time once. */
export function recordReport(report: FullReport, file = historyFile()): void {
  const readAt = report.read_at;
  if (!readAt) return;
  const providers = new Map<string, Sample[]>();
  for (const sample of samplesFrom(report)) {
    const t = readAt[sample.p];
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
    const samples = providers.get(sample.p);
    if (samples) samples.push(sample);
    else providers.set(sample.p, [sample]);
  }
  if (!providers.size) return;

  const db = openHistoryDatabase(file);
  try {
    const insert = db.query(`
      INSERT INTO allowance_readings (provider, read_at, samples) VALUES (?, ?, ?)
      ON CONFLICT (provider, read_at) DO NOTHING
    `);
    db.transaction(() => {
      for (const [provider, samples] of providers) {
        insert.run(provider, readAt[provider]!, JSON.stringify(samples));
      }
    }).immediate();
  } finally {
    db.close();
  }
}

export function readHistory(file = historyFile(), since = 0): Entry[] {
  if (!existsSync(file)) return [];
  const db = openHistoryDatabase(file, true);
  try {
    // A new file may be visible before the first writer commits the schema.
    if (!db.query("SELECT 1 FROM sqlite_schema WHERE name = 'allowance_readings'").get()) return [];
    const rows = db.query<{ t: number; samples: string }, [number]>(
      "SELECT read_at AS t, samples FROM allowance_readings WHERE read_at >= ? ORDER BY read_at, rowid",
    ).all(since);
    const entries: Entry[] = [];
    for (const { t, samples } of rows) {
      const parsed = JSON.parse(samples) as Sample[];
      const last = entries.at(-1);
      if (last?.t === t) last.s.push(...parsed);
      else entries.push({ t, s: parsed });
    }
    return entries;
  } finally {
    db.close();
  }
}

// An Antigravity limit is known by its window length rather than its label, so the same limit
// read two ways ("Five Hour Limit Remaining" from the agy CLI, "5h limit" from the API fallback)
// is one chart. Other providers keep their labels: Claude's "7d weekly", "7d Opus" and
// "7d Sonnet" are separate limits of one length.
const windowOf = (s: Sample) => (s.p === "antigravity" ? windowLength(s.w) ?? s.w : s.w);
const limitOf = (s: Sample) => `${s.p}\u0000${s.g ?? ""}\u0000${windowOf(s)}`;
// A full limit whose reset is a whole window after the reading hasn't started: the provider
// quotes a reset that rolls forward with every read until the first request.
const ROLLING = MINUTE;
const CHARTED = new Set([5 * HOUR, WEEK]);

export function readBurndowns(file = historyFile(), now = Date.now()): Burndown[] {
  // The longest window is one week, and a chart's latest reading can be a day old.
  return burndowns(readHistory(file, now - WEEK - DAY), now);
}

/**
 * The current 5-hour and weekly window of every limit read in the last day, oldest reading
 * first. A window runs from its reset minus its length to its reset; with no reset, a full
 * (100%) limit starts at now so it stays pinned to the left, while a partially used one runs
 * for its length up to now.
 */
export function burndowns(entries: Entry[], now = Date.now()): Burndown[] {
  // Readings recorded before accounts were kept belong to the limit's account when it has one.
  const accounts = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const s of entry.s) {
      if (!s.a) continue;
      if (!accounts.has(limitOf(s))) accounts.set(limitOf(s), new Set());
      accounts.get(limitOf(s))!.add(s.a);
    }
  }
  const accountOf = (s: Sample) => {
    if (s.a) return s.a;
    const known = accounts.get(limitOf(s));
    return known?.size === 1 ? [...known][0] : "";
  };
  const series = new Map<string, Array<{ t: number; s: Sample }>>();
  for (const entry of entries) {
    for (const s of entry.s) {
      const key = `${limitOf(s)}\u0000${accountOf(s)}`;
      if (!series.has(key)) series.set(key, []);
      series.get(key)!.push({ t: entry.t, s });
    }
  }
  const result: Burndown[] = [];
  // A limit missing from its provider's latest reading is gone (a model group folded into
  // another, say), so only the limits that reading has are charted.
  const latestRead = new Map<string, number>();
  for (const readings of series.values()) {
    const { t, s } = readings.at(-1)!;
    const key = `${s.p}\u0000${accountOf(s)}`;
    latestRead.set(key, Math.max(latestRead.get(key) ?? 0, t));
  }
  for (const readings of series.values()) {
    const latest = readings.at(-1)!;
    if (now - latest.t > DAY) continue;
    if (latest.t < latestRead.get(`${latest.s.p}\u0000${accountOf(latest.s)}`)!) continue;
    const length = windowLength(latest.s.w);
    if (!length || !CHARTED.has(length)) continue;
    // Antigravity's epoch reset (saved before the fetcher dropped it) means no window running.
    const parsed = Date.parse(latest.s.reset ?? "");
    const quoted = parsed > 0 ? parsed : NaN;
    const rolling = latest.s.left >= 100 && quoted >= latest.t + length - ROLLING;
    const reset = rolling ? NaN : quoted;
    const unstarted = !Number.isFinite(reset) && latest.s.left >= 100;
    const end = Number.isFinite(reset) ? reset : unstarted ? now + length : now;
    const start = end - length;
    const inWindow = unstarted ? [] : readings.filter((r) => r.t >= start && r.t <= end);
    const account = accountOf(latest.s);
    result.push({
      provider: latest.s.p,
      ...(account ? { account } : {}),
      ...(latest.s.g ? { group: latest.s.g } : {}),
      label: latest.s.w,
      length,
      start,
      end,
      left: latest.s.left,
      reset: Number.isFinite(reset) ? latest.s.reset : null,
      runs: unstarted
        ? [[start, start, latest.s.left]]
        : runs(inWindow.map((r) => [r.t, r.s.left]), length, Math.min(now, end)),
    });
  }
  return result;
}

/**
 * Readings as step-line runs. Readings are thinned to the last in each of BUCKETS slices of the
 * window, a value holds until the next reading, and equal neighbours merge. A reading more than
 * `gap` from the next one (the app was closed, the machine asleep) holds for one slice, then
 * the line breaks. The last reading holds until `until` unless that's a gap too.
 */
export function runs(readings: Array<[number, number]>, length: number, until: number): Array<[number, number, number]> {
  const slice = length / BUCKETS;
  const gap = Math.max(20 * MINUTE, 3 * slice);
  const thinned: Array<[number, number]> = [];
  for (const reading of readings) {
    const last = thinned.at(-1);
    if (last && Math.floor(last[0] / slice) === Math.floor(reading[0] / slice)) thinned[thinned.length - 1] = reading;
    else thinned.push(reading);
  }
  const out: Array<[number, number, number]> = [];
  thinned.forEach(([t, left], i) => {
    const next = thinned[i + 1]?.[0] ?? until;
    const to = next - t <= gap ? Math.max(next, t) : t + slice;
    const prev = out.at(-1);
    if (prev && prev[1] === t && prev[2] === left) prev[1] = to;
    else out.push([t, to, left]);
  });
  return out;
}
