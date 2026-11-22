// Allowance history, kept on this machine only, for the burndown charts.
//
// Each provider's figures go into history.jsonl once, stamped with when they were read: each
// limit's % left with its reset time. Any report the bridge handles is checked, so readings are
// kept whichever program refreshed the cache. Nothing leaves the machine. Entries older than
// 8 days are dropped, enough for a full weekly window and the one before it started.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FullReport } from "./fetcher.ts";
import { windowLength } from "./herdr-app/mods/usage-monitor/pace.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const KEEP_MS = 8 * DAY;
// Charts draw this many steps across a window at most.
export const BUCKETS = 180;

/** One limit at one moment. p: provider id; g: model group or scope, when the provider splits a
 *  limit by model; w: the limit's label; left: % left; reset: when it resets, if known. */
export interface Sample {
  p: string;
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
  group?: string;
  label: string;
  length: number;
  start: number;
  end: number;
  left: number;
  reset: string | null;
  runs: Array<[number, number, number]>;
}

export function historyFile(): string {
  if (process.env["HERDR_USAGE_HISTORY_FILE"]) return process.env["HERDR_USAGE_HISTORY_FILE"];
  const data = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  return join(data, "herdr-usage-monitor", "history.jsonl");
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Every limit in a report, as samples. A report can carry older figures for a provider that
 *  wasn't read this time; recordReport uses read_at to tell them apart. */
export function samplesFrom(report: FullReport): Sample[] {
  const samples: Sample[] = [];
  for (const [id, provider] of [["claude", report.claude], ["codex", report.codex]] as const) {
    for (const w of provider?.windows ?? []) {
      samples.push({ p: id, w: w.label, left: round(100 - w.used_percent), reset: w.resets_at ?? null });
    }
  }
  for (const group of report.antigravity?.groups ?? []) {
    for (const b of group.buckets ?? []) {
      samples.push({ p: "antigravity", g: group.name, w: b.label, left: round(b.remaining_percent), reset: b.resets_at ?? null });
    }
  }
  for (const provider of report.others ?? []) {
    for (const w of provider.windows ?? []) {
      samples.push({
        p: provider.id,
        ...(w.scope ? { g: w.scope } : {}),
        w: w.kind,
        left: round(100 - w.used_percent),
        reset: w.resets_at ?? null,
      });
    }
  }
  return samples.filter((s) => Number.isFinite(s.left));
}

export function recordHistory(samples: Sample[], t = Date.now(), file = historyFile()): void {
  if (samples.length === 0) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ t, s: samples })}\n`);
    pruneHistory(file, t);
  } catch {}
}

// How far back recordReport looks for each provider's last recorded reading.
const TAIL_BYTES = 256 * 1024;

/** Each provider's latest recorded reading in the end of the file, and the oldest reading that
 *  part reaches back to (-Infinity when it's the whole file). */
export function recentReadings(file = historyFile()): { last: Map<string, number>; since: number } {
  const last = new Map<string, number>();
  let since = -Infinity;
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { last, since };
  }
  try {
    const size = fstatSync(fd).size;
    const offset = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (offset > 0) {
      lines.shift(); // starts mid-line
      since = Infinity;
    }
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Entry;
        if (offset > 0) since = Math.min(since, entry.t);
        for (const s of entry.s) last.set(s.p, Math.max(last.get(s.p) ?? -Infinity, entry.t));
      } catch {}
    }
  } finally {
    closeSync(fd);
  }
  return { last, since };
}

/**
 * Records a report's figures that aren't in the history yet: each provider whose read_at is
 * newer than its last recorded reading, as a line stamped with that time. A report without
 * read_at (from an older version) records nothing, since fresh figures can't be told from
 * carried-over ones. Two bridges handling the same report at once can both record it; equal
 * readings at the same time draw as one.
 */
export function recordReport(report: FullReport, file = historyFile()): void {
  const readAt = report.read_at;
  if (!readAt) return;
  const { last, since } = recentReadings(file);
  const lines = new Map<number, Sample[]>();
  for (const sample of samplesFrom(report)) {
    const t = readAt[sample.p];
    if (!t || t < since || t <= (last.get(sample.p) ?? -Infinity)) continue;
    if (!lines.has(t)) lines.set(t, []);
    lines.get(t)!.push(sample);
  }
  for (const [t, samples] of [...lines].sort((a, b) => a[0] - b[0])) recordHistory(samples, t, file);
}

function firstTime(file: string): number | null {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, read).toString("utf8").split("\n")[0];
    const t = JSON.parse(line ?? "").t;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Drops entries older than KEEP_MS. It rewrites the file only once the oldest entry is a day
 *  past that, so about once a day rather than on every read. */
export function pruneHistory(file: string, now = Date.now()): void {
  const oldest = firstTime(file);
  if (oldest !== null && now - oldest < KEEP_MS + DAY) return;
  const kept = readFileSync(file, "utf8").split("\n").filter((line) => {
    try {
      return JSON.parse(line).t >= now - KEEP_MS;
    } catch {
      return false;
    }
  });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, kept.map((line) => `${line}\n`).join(""));
  renameSync(temp, file);
}

export function readHistory(file = historyFile()): Entry[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (Number.isFinite(entry.t) && Array.isArray(entry.s)) entries.push(entry);
    } catch {}
  }
  return entries.sort((a, b) => a.t - b.t);
}

const keyOf = (s: Sample) => `${s.p}\u0000${s.g ?? ""}\u0000${s.w}`;
const CHARTED = new Set([5 * HOUR, 7 * DAY]);

/**
 * The current 5-hour and weekly window of every limit read in the last day, oldest reading
 * first. A window runs from its reset minus its length to its reset; with no reset (Claude's
 * 5-hour limit before a session starts), it's the length up to now.
 */
export function burndowns(entries: Entry[], now = Date.now()): Burndown[] {
  const series = new Map<string, Array<{ t: number; s: Sample }>>();
  for (const entry of entries) {
    for (const s of entry.s) {
      const key = keyOf(s);
      if (!series.has(key)) series.set(key, []);
      series.get(key)!.push({ t: entry.t, s });
    }
  }
  const result: Burndown[] = [];
  for (const readings of series.values()) {
    const latest = readings.at(-1)!;
    if (now - latest.t > DAY) continue;
    const length = windowLength(latest.s.w);
    if (!length || !CHARTED.has(length)) continue;
    const reset = Date.parse(latest.s.reset ?? "");
    const end = Number.isFinite(reset) ? reset : now;
    const start = end - length;
    const inWindow = readings.filter((r) => r.t >= start && r.t <= end);
    result.push({
      provider: latest.s.p,
      ...(latest.s.g ? { group: latest.s.g } : {}),
      label: latest.s.w,
      length,
      start,
      end,
      left: latest.s.left,
      reset: latest.s.reset,
      runs: runs(inWindow.map((r) => [r.t, r.s.left]), length, Math.min(now, end)),
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
