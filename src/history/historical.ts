// Local-time historical model & token aggregation over history.sqlite.
import { existsSync } from "node:fs";
import { historyFile, openHistoryDatabase } from "./db.ts";

export type Horizon = "d" | "w" | "m" | "y";
export type DeltaKind = "up" | "down" | "flat" | "new" | "none";

export interface HistoricalOptions {
  horizon?: Horizon;
  /** 0 = current calendar period, -1 = previous, etc. Clamped to <= 0. */
  offset?: number;
  provider?: string;
  model?: string;
  includeCache?: boolean;
  now?: number;
}

export interface HistoricalBucket {
  startMs: number;
  endMs: number;
  label: string;
  axisLabel: string;
  future: boolean;
  total: number;
  cumulativeTotal: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  events: number;
  byModel: Record<string, number>;
  cumulativeByModel: Record<string, number>;
}

export interface HistoricalLeader {
  rank: number;
  model: string;
  provider: string;
  providers: string[];
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  sessions: number;
  events: number;
  sharePct: number;
  prevTokens: number | null;
  deltaPct: number | null;
  deltaKind: DeltaKind;
  efforts: Array<{ effort: string; sharePct: number }>;
}

export interface HistoricalPayload {
  version: 1;
  horizon: Horizon;
  offset: number;
  includeCache: boolean;
  filters: { provider: string; model: string };
  latestActivityMs: number | null;
  range: {
    startMs: number;
    endMs: number;
    elapsedEndMs: number;
    label: string;
    subtitle: string;
    hasNext: boolean;
  };
  summary: {
    totalTokens: number;
    prevTotalTokens: number | null;
    deltaPct: number | null;
    deltaKind: DeltaKind;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    cacheHitRate: number | null;
    sessions: number;
    events: number;
    unmeasuredEvents: number;
    topModel: { model: string; provider: string; tokens: number; sharePct: number } | null;
    peakBucket: { label: string; tokens: number } | null;
  };
  series: {
    models: string[];
    maxBucketTotal: number;
    maxModelBucket: number;
    maxCumulativeTotal: number;
    maxModelCumulative: number;
    buckets: HistoricalBucket[];
  };
  leaderboard: {
    totalModels: number;
    entries: HistoricalLeader[];
  };
  facets: {
    providers: Array<{ value: string; label: string; tokens: number; sessions: number }>;
    models: Array<{ value: string; tokens: number; sessions: number }>;
  };
  backfill: {
    pendingFiles: number;
    totalFiles: number;
  };
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi",
};

const TOP_SERIES_LIMIT = 7;
const LEADERBOARD_LIMIT = 10;
const FACET_MODEL_LIMIT = 250;

const round1 = (value: number) => Math.round(value * 10) / 10;

function providerDisplay(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

function cleanFilter(value: string | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "all" || trimmed === "*") return "all";
  return trimmed;
}

function parseHorizon(value: string | undefined): Horizon {
  const v = String(value ?? "").toLowerCase();
  return v === "d" || v === "w" || v === "m" || v === "y" ? v : "m";
}

function formatHourShort(hour: number): string {
  if (hour === 0) return "12a";
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

function formatHourClock(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 || 12}:00 ${h < 12 ? "AM" : "PM"}`;
}

function formatShortDate(date: Date, includeYear = false): string {
  const base = `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
  return includeYear ? `${base}, ${date.getFullYear()}` : base;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

interface BucketSpec {
  startMs: number;
  endMs: number;
  label: string;
  axisLabel: string;
}

interface HorizonWindow {
  startMs: number;
  endMs: number;
  prevStartMs: number;
  prevEndMs: number;
  label: string;
  unitSummary: string;
  buckets: BucketSpec[];
}

export function buildHorizonWindow(horizon: Horizon, offset: number, now: number): HorizonWindow {
  const safeOffset = Number.isFinite(offset) ? Math.min(0, Math.trunc(offset)) : 0;
  const current = new Date(now);
  const curY = current.getFullYear();
  const curM = current.getMonth();
  const curD = current.getDate();

  if (horizon === "d") {
    const target = new Date(curY, curM, curD + safeOffset, 0, 0, 0, 0);
    const tY = target.getFullYear();
    const tM = target.getMonth();
    const tD = target.getDate();
    const startMs = target.getTime();
    const endMs = new Date(tY, tM, tD + 1, 0, 0, 0, 0).getTime();

    const prevStart = new Date(tY, tM, tD - 1, 0, 0, 0, 0);
    const prevStartMs = prevStart.getTime();
    const prevEndMs = safeOffset === 0
      ? Math.min(startMs, prevStartMs + Math.max(0, now - startMs))
      : startMs;

    const dateTag = formatShortDate(target, tY !== curY);
    const label = safeOffset === 0 ? `Today · ${dateTag}`
      : safeOffset === -1 ? `Yesterday · ${dateTag}`
        : `${WEEKDAYS_SHORT[target.getDay()]}, ${formatShortDate(target, true)}`;

    const buckets: BucketSpec[] = [];
    for (let h = 0; h < 24; h += 1) {
      const bStart = new Date(tY, tM, tD, h, 0, 0, 0).getTime();
      const bEnd = h === 23 ? endMs : new Date(tY, tM, tD, h + 1, 0, 0, 0).getTime();
      buckets.push({
        startMs: bStart,
        endMs: bEnd,
        label: `${dateTag} · ${formatHourClock(h)}–${formatHourClock(h + 1)}`,
        axisLabel: h % 4 === 0 ? formatHourShort(h) : "",
      });
    }
    return { startMs, endMs, prevStartMs, prevEndMs, label, unitSummary: "24 hours", buckets };
  }

  if (horizon === "w") {
    const dow = (current.getDay() + 6) % 7; // Monday = 0 .. Sunday = 6
    const monday = new Date(curY, curM, curD - dow + safeOffset * 7, 0, 0, 0, 0);
    const mY = monday.getFullYear();
    const mM = monday.getMonth();
    const mD = monday.getDate();
    const startMs = monday.getTime();
    const endMs = new Date(mY, mM, mD + 7, 0, 0, 0, 0).getTime();
    const sunday = new Date(mY, mM, mD + 6, 0, 0, 0, 0);

    const prevStartMs = new Date(mY, mM, mD - 7, 0, 0, 0, 0).getTime();
    const prevEndMs = safeOffset === 0
      ? Math.min(startMs, prevStartMs + Math.max(0, now - startMs))
      : startMs;

    const crossYear = monday.getFullYear() !== sunday.getFullYear();
    const showYear = monday.getFullYear() !== curY || crossYear;
    const span = `${formatShortDate(monday, crossYear)} – ${formatShortDate(sunday, showYear)}`;
    const label = safeOffset === 0 ? `This week · ${span}` : span;

    const buckets: BucketSpec[] = [];
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(mY, mM, mD + i, 0, 0, 0, 0);
      const bStart = day.getTime();
      const bEnd = new Date(mY, mM, mD + i + 1, 0, 0, 0, 0).getTime();
      buckets.push({
        startMs: bStart,
        endMs: bEnd,
        label: `${WEEKDAYS_SHORT[day.getDay()]}, ${formatShortDate(day, day.getFullYear() !== curY)}`,
        axisLabel: `${WEEKDAYS_SHORT[day.getDay()]} ${day.getDate()}`,
      });
    }
    return { startMs, endMs, prevStartMs, prevEndMs, label, unitSummary: "7 days", buckets };
  }

  if (horizon === "m") {
    const first = new Date(curY, curM + safeOffset, 1, 0, 0, 0, 0);
    const fY = first.getFullYear();
    const fM = first.getMonth();
    const count = daysInMonth(fY, fM);
    const startMs = first.getTime();
    const endMs = new Date(fY, fM + 1, 1, 0, 0, 0, 0).getTime();

    const prevFirst = new Date(fY, fM - 1, 1, 0, 0, 0, 0);
    const prevStartMs = prevFirst.getTime();
    let prevEndMs = startMs;
    if (safeOffset === 0) {
      const prevDays = daysInMonth(prevFirst.getFullYear(), prevFirst.getMonth());
      const clampedDay = Math.min(curD, prevDays);
      const prevSameMoment = new Date(
        prevFirst.getFullYear(),
        prevFirst.getMonth(),
        clampedDay,
        current.getHours(),
        current.getMinutes(),
        current.getSeconds(),
        current.getMilliseconds(),
      ).getTime();
      prevEndMs = Math.min(startMs, prevSameMoment);
    }

    const label = `${MONTHS_LONG[fM]} ${fY}`;
    const buckets: BucketSpec[] = [];
    for (let d = 1; d <= count; d += 1) {
      const day = new Date(fY, fM, d, 0, 0, 0, 0);
      const bStart = day.getTime();
      const bEnd = new Date(fY, fM, d + 1, 0, 0, 0, 0).getTime();
      const showTick = d === 1 || (d % 5 === 1 && count - d >= 2);
      buckets.push({
        startMs: bStart,
        endMs: bEnd,
        label: `${WEEKDAYS_SHORT[day.getDay()]}, ${formatShortDate(day, fY !== curY)}`,
        axisLabel: showTick ? `${MONTHS_SHORT[fM]} ${d}` : "",
      });
    }
    return { startMs, endMs, prevStartMs, prevEndMs, label, unitSummary: `${count} days`, buckets };
  }

  // horizon === "y": calendar year in 52 weekly buckets (final bucket absorbs Dec 31 / leap day).
  const targetYear = curY + safeOffset;
  const startMs = new Date(targetYear, 0, 1, 0, 0, 0, 0).getTime();
  const endMs = new Date(targetYear + 1, 0, 1, 0, 0, 0, 0).getTime();

  const prevStartMs = new Date(targetYear - 1, 0, 1, 0, 0, 0, 0).getTime();
  let prevEndMs = startMs;
  if (safeOffset === 0) {
    const clampedDay = Math.min(curD, daysInMonth(targetYear - 1, curM));
    const prevSameMoment = new Date(
      targetYear - 1,
      curM,
      clampedDay,
      current.getHours(),
      current.getMinutes(),
      current.getSeconds(),
      current.getMilliseconds(),
    ).getTime();
    prevEndMs = Math.min(startMs, prevSameMoment);
  }

  const buckets: BucketSpec[] = [];
  let lastLabeledMonth = -1;
  for (let w = 0; w < 52; w += 1) {
    const bStartDate = new Date(targetYear, 0, 1 + w * 7, 0, 0, 0, 0);
    const bEndDate = w === 51
      ? new Date(targetYear + 1, 0, 1, 0, 0, 0, 0)
      : new Date(targetYear, 0, 1 + (w + 1) * 7, 0, 0, 0, 0);
    const lastDay = new Date(bEndDate.getTime() - 1);
    const month = bStartDate.getMonth();
    const axisLabel = month !== lastLabeledMonth ? MONTHS_SHORT[month]! : "";
    lastLabeledMonth = month;
    buckets.push({
      startMs: bStartDate.getTime(),
      endMs: bEndDate.getTime(),
      label: `${formatShortDate(bStartDate)} – ${formatShortDate(lastDay, true)}`,
      axisLabel,
    });
  }

  return {
    startMs,
    endMs,
    prevStartMs,
    prevEndMs,
    label: String(targetYear),
    unitSummary: "52 weeks",
    buckets,
  };
}

function compareChange(current: number, previous: number | null): { deltaPct: number | null; deltaKind: DeltaKind } {
  if (previous === null) return { deltaPct: null, deltaKind: "none" };
  if (previous === 0) {
    if (current === 0) return { deltaPct: 0, deltaKind: "flat" };
    return { deltaPct: null, deltaKind: "new" };
  }
  const pct = round1(((current - previous) / previous) * 100);
  if (pct === 0) return { deltaPct: 0, deltaKind: "flat" };
  return { deltaPct: pct, deltaKind: pct > 0 ? "up" : "down" };
}

function tokenSum(
  row: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number },
  includeCache: boolean,
): number {
  return row.input_tokens + row.output_tokens + (includeCache ? row.cache_read_tokens + row.cache_write_tokens : 0);
}

function bucketIndexFor(buckets: BucketSpec[], timestamp: number): number {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = buckets[mid]!;
    if (timestamp < b.startMs) hi = mid - 1;
    else if (timestamp >= b.endMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

interface RawUsageRow {
  provider: string;
  observed_at: number;
  model: string;
  effort: string | null;
  session_id: string | null;
  source_kind: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
}

interface PrevAggRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface FacetAggRow {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  sessions: number;
}

function emptyPayload(
  horizon: Horizon,
  offset: number,
  includeCache: boolean,
  filters: { provider: string; model: string },
  win: HorizonWindow,
  now: number,
  backfill = { pendingFiles: 0, totalFiles: 0 },
): HistoricalPayload {
  return {
    version: 1,
    horizon,
    offset,
    includeCache,
    filters,
    latestActivityMs: null,
    range: {
      startMs: win.startMs,
      endMs: win.endMs,
      elapsedEndMs: Math.min(now, win.endMs),
      label: win.label,
      subtitle: `${win.unitSummary} · ${includeCache ? "cache included" : "cache excluded"}`,
      hasNext: offset < 0,
    },
    summary: {
      totalTokens: 0,
      prevTotalTokens: null,
      deltaPct: null,
      deltaKind: "none",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      cacheHitRate: null,
      sessions: 0,
      events: 0,
      unmeasuredEvents: 0,
      topModel: null,
      peakBucket: null,
    },
    series: {
      models: [],
      maxBucketTotal: 0,
      maxModelBucket: 0,
      maxCumulativeTotal: 0,
      maxModelCumulative: 0,
      buckets: win.buckets.map((spec) => ({
        startMs: spec.startMs,
        endMs: spec.endMs,
        label: spec.label,
        axisLabel: spec.axisLabel,
        future: spec.startMs > now,
        total: 0,
        cumulativeTotal: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        events: 0,
        byModel: {},
        cumulativeByModel: {},
      })),
    },
    leaderboard: { totalModels: 0, entries: [] },
    facets: { providers: [], models: [] },
    backfill,
  };
}

export function readHistorical(
  options: HistoricalOptions = {},
  file = historyFile(),
  backfill = { pendingFiles: 0, totalFiles: 0 },
): HistoricalPayload {
  const now = options.now ?? Date.now();
  const horizon = parseHorizon(options.horizon);
  const offset = Number.isFinite(options.offset) ? Math.min(0, Math.trunc(options.offset!)) : 0;
  const includeCache = options.includeCache !== false;
  const providerFilter = cleanFilter(options.provider);
  const modelFilter = cleanFilter(options.model);
  const filters = { provider: providerFilter, model: modelFilter };
  const win = buildHorizonWindow(horizon, offset, now);

  if (!existsSync(file)) {
    return emptyPayload(horizon, offset, includeCache, filters, win, now, backfill);
  }

  const db = openHistoryDatabase(file, true);
  try {
    if (!db.query("SELECT 1 FROM sqlite_schema WHERE name = 'model_usage'").get()) {
      return emptyPayload(horizon, offset, includeCache, filters, win, now, backfill);
    }
    const cols = new Set(
      db.query<{ name: string }, []>("PRAGMA table_info(model_usage)").all().map((c) => c.name),
    );
    if (!cols.has("input_tokens")) {
      const legacyCount = db.query<{ c: number }, [number, number]>(
        "SELECT COUNT(*) AS c FROM model_usage WHERE observed_at >= ? AND observed_at < ?",
      ).get(win.startMs, win.endMs)?.c ?? 0;
      const result = emptyPayload(horizon, offset, includeCache, filters, win, now, backfill);
      result.summary.unmeasuredEvents = legacyCount;
      return result;
    }

    const whereParts = ["observed_at >= ?", "observed_at < ?"];
    const params: Array<string | number> = [win.startMs, win.endMs];
    if (providerFilter !== "all") {
      whereParts.push("provider = ?");
      params.push(providerFilter);
    }
    if (modelFilter !== "all") {
      whereParts.push("model = ?");
      params.push(modelFilter);
    }

    const rows = db.query<RawUsageRow, Array<string | number>>(`
      SELECT provider, observed_at, model, effort, session_id, source_kind,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
      FROM model_usage
      WHERE ${whereParts.join(" AND ")}
      ORDER BY observed_at
    `).all(...params);

    const prevWhereParts = ["observed_at >= ?", "observed_at < ?", "input_tokens IS NOT NULL"];
    const prevParams: Array<string | number> = [win.prevStartMs, win.prevEndMs];
    if (providerFilter !== "all") {
      prevWhereParts.push("provider = ?");
      prevParams.push(providerFilter);
    }
    if (modelFilter !== "all") {
      prevWhereParts.push("model = ?");
      prevParams.push(modelFilter);
    }

    const prevRows = db.query<PrevAggRow, Array<string | number>>(`
      SELECT model,
             SUM(COALESCE(input_tokens, 0)) AS input_tokens,
             SUM(COALESCE(output_tokens, 0)) AS output_tokens,
             SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
             SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens
      FROM model_usage
      WHERE ${prevWhereParts.join(" AND ")}
      GROUP BY model
    `).all(...prevParams);

    const prevByModel = new Map<string, number>();
    let prevTotalTokens = 0;
    for (const row of prevRows) {
      const sum = tokenSum(row, includeCache);
      prevByModel.set(row.model, sum);
      prevTotalTokens += sum;
    }

    // Check whether ANY measured history exists before the start of this period so "none" vs "new" is honest.
    const earliestMeasured = db.query<{ earliest: number | null; latest: number | null }, []>(
      "SELECT MIN(observed_at) AS earliest, MAX(observed_at) AS latest FROM model_usage WHERE input_tokens IS NOT NULL",
    ).get();
    const hasPrevHistory = earliestMeasured?.earliest != null && earliestMeasured.earliest < win.prevEndMs;
    const latestActivityMs = earliestMeasured?.latest ?? null;

    // Facets across the current window (each facet ignores its own active filter so switching stays seamless)
    // plus any known providers/models from the DB so quiet days still show choices.
    const allKnownProviders = db.query<{ provider: string }, []>(
      "SELECT DISTINCT provider FROM model_usage WHERE input_tokens IS NOT NULL ORDER BY provider",
    ).all().map((r) => r.provider);

    const windowFacetRows = db.query<FacetAggRow, [number, number]>(`
      SELECT provider, model,
             SUM(COALESCE(input_tokens, 0)) AS input_tokens,
             SUM(COALESCE(output_tokens, 0)) AS output_tokens,
             SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
             SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
             COUNT(DISTINCT session_id) AS sessions
      FROM model_usage
      WHERE observed_at >= ? AND observed_at < ? AND input_tokens IS NOT NULL
      GROUP BY provider, model
    `).all(win.startMs, win.endMs);

    const providerFacetMap = new Map<string, { tokens: number; sessions: number }>();
    for (const p of allKnownProviders) providerFacetMap.set(p, { tokens: 0, sessions: 0 });
    const modelFacetMap = new Map<string, { tokens: number; sessions: number }>();

    for (const r of windowFacetRows) {
      const tokens = tokenSum(r, includeCache);
      if (modelFilter === "all" || r.model === modelFilter) {
        const entry = providerFacetMap.get(r.provider) ?? { tokens: 0, sessions: 0 };
        entry.tokens += tokens;
        entry.sessions += r.sessions;
        providerFacetMap.set(r.provider, entry);
      }
      if (providerFilter === "all" || r.provider === providerFilter) {
        const entry = modelFacetMap.get(r.model) ?? { tokens: 0, sessions: 0 };
        entry.tokens += tokens;
        entry.sessions += r.sessions;
        modelFacetMap.set(r.model, entry);
      }
    }
    if (providerFilter !== "all" && !providerFacetMap.has(providerFilter)) {
      providerFacetMap.set(providerFilter, { tokens: 0, sessions: 0 });
    }
    if (modelFilter !== "all" && !modelFacetMap.has(modelFilter)) {
      modelFacetMap.set(modelFilter, { tokens: 0, sessions: 0 });
    }

    const providerFacets = [...providerFacetMap.entries()]
      .map(([value, stat]) => ({ value, label: providerDisplay(value), tokens: stat.tokens, sessions: stat.sessions }))
      .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));

    const allModelFacets = [...modelFacetMap.entries()]
      .map(([value, stat]) => ({ value, tokens: stat.tokens, sessions: stat.sessions }))
      .sort((a, b) => b.tokens - a.tokens || a.value.localeCompare(b.value));
    const modelFacets = allModelFacets.slice(0, FACET_MODEL_LIMIT);
    if (modelFilter !== "all" && !modelFacets.some((m) => m.value === modelFilter)) {
      const selected = allModelFacets.find((m) => m.value === modelFilter);
      if (selected) {
        if (modelFacets.length >= FACET_MODEL_LIMIT) modelFacets.pop();
        modelFacets.push(selected);
      }
    }

    // Aggregate current window into buckets and per-model groups.
    const bucketAccum = win.buckets.map((spec) => ({
      spec,
      total: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      events: 0,
      byModel: new Map<string, number>(),
    }));

    interface ModelGroup {
      model: string;
      tokens: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
      events: number;
      sessions: Set<string>;
      providers: Map<string, number>;
      efforts: Map<string, number>;
    }
    const modelGroups = new Map<string, ModelGroup>();
    const allSessions = new Set<string>();

    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let reasoningTokens = 0;
    let events = 0;
    let unmeasuredEvents = 0;

    for (const row of rows) {
      if (row.input_tokens === null) {
        if (row.source_kind === null) unmeasuredEvents += 1;
        continue;
      }
      const input = row.input_tokens ?? 0;
      const output = row.output_tokens ?? 0;
      const cacheRead = row.cache_read_tokens ?? 0;
      const cacheWrite = row.cache_write_tokens ?? 0;
      const reasoning = row.reasoning_tokens ?? 0;
      const tokens = input + output + (includeCache ? cacheRead + cacheWrite : 0);

      totalTokens += tokens;
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cacheRead;
      cacheWriteTokens += cacheWrite;
      reasoningTokens += reasoning;
      events += 1;
      if (row.session_id) allSessions.add(row.session_id);

      let group = modelGroups.get(row.model);
      if (!group) {
        group = {
          model: row.model,
          tokens: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          events: 0,
          sessions: new Set(),
          providers: new Map(),
          efforts: new Map(),
        };
        modelGroups.set(row.model, group);
      }
      group.tokens += tokens;
      group.input += input;
      group.output += output;
      group.cacheRead += cacheRead;
      group.cacheWrite += cacheWrite;
      group.reasoning += reasoning;
      group.events += 1;
      if (row.session_id) group.sessions.add(row.session_id);
      group.providers.set(row.provider, (group.providers.get(row.provider) ?? 0) + Math.max(tokens, 1));
      if (row.effort) {
        group.efforts.set(row.effort, (group.efforts.get(row.effort) ?? 0) + Math.max(tokens, 1));
      }

      const idx = bucketIndexFor(win.buckets, row.observed_at);
      if (idx >= 0) {
        const b = bucketAccum[idx]!;
        b.total += tokens;
        b.input += input;
        b.output += output;
        b.cacheRead += cacheRead;
        b.cacheWrite += cacheWrite;
        b.events += 1;
        if (tokens > 0) {
          b.byModel.set(row.model, (b.byModel.get(row.model) ?? 0) + tokens);
        }
      }
    }

    const sortedGroups = [...modelGroups.values()].sort(
      (a, b) => b.tokens - a.tokens || b.events - a.events || a.model.localeCompare(b.model),
    );

    const topModels = sortedGroups
      .filter((g) => g.tokens > 0)
      .slice(0, TOP_SERIES_LIMIT)
      .map((g) => g.model);
    const keepSet = new Set(topModels);
    let hasOther = false;
    for (const b of bucketAccum) {
      for (const [m, t] of b.byModel) {
        if (t > 0 && !keepSet.has(m)) {
          hasOther = true;
          break;
        }
      }
      if (hasOther) break;
    }
    const seriesModels = hasOther ? [...topModels, "Other"] : topModels;

    let runningTotal = 0;
    const runningByModel = new Map<string, number>();
    let maxBucketTotal = 0;
    let maxModelBucket = 0;
    let maxCumulativeTotal = 0;
    let maxModelCumulative = 0;
    let peakBucket: { label: string; tokens: number } | null = null;

    const buckets: HistoricalBucket[] = bucketAccum.map((b) => {
      const future = b.spec.startMs > now;
      const byModel: Record<string, number> = {};
      let other = 0;

      for (const name of topModels) {
        const val = b.byModel.get(name) ?? 0;
        if (val > 0) {
          byModel[name] = val;
          if (val > maxModelBucket) maxModelBucket = val;
        }
      }
      for (const [name, val] of b.byModel) {
        if (!keepSet.has(name)) other += val;
      }
      if (other > 0) {
        byModel.Other = other;
        if (other > maxModelBucket) maxModelBucket = other;
      }

      if (!future) {
        runningTotal += b.total;
        if (runningTotal > maxCumulativeTotal) maxCumulativeTotal = runningTotal;
        for (const name of seriesModels) {
          const next = (runningByModel.get(name) ?? 0) + (byModel[name] ?? 0);
          runningByModel.set(name, next);
          if (next > maxModelCumulative) maxModelCumulative = next;
        }
      }

      const cumulativeByModel: Record<string, number> = {};
      if (!future) {
        for (const name of seriesModels) {
          const val = runningByModel.get(name) ?? 0;
          if (val > 0) cumulativeByModel[name] = val;
        }
      }

      if (b.total > maxBucketTotal) maxBucketTotal = b.total;
      if (b.total > 0 && (!peakBucket || b.total > peakBucket.tokens)) {
        peakBucket = { label: b.spec.label, tokens: b.total };
      }

      return {
        startMs: b.spec.startMs,
        endMs: b.spec.endMs,
        label: b.spec.label,
        axisLabel: b.spec.axisLabel,
        future,
        total: b.total,
        cumulativeTotal: future ? 0 : runningTotal,
        input: b.input,
        output: b.output,
        cacheRead: b.cacheRead,
        cacheWrite: b.cacheWrite,
        events: b.events,
        byModel,
        cumulativeByModel,
      };
    });

    const leaderboardEntries: HistoricalLeader[] = sortedGroups.slice(0, LEADERBOARD_LIMIT).map((g, i) => {
      const providersSorted = [...g.providers.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const primaryProvider = providersSorted[0]?.[0] ?? "unknown";
      const prevTokens = hasPrevHistory ? (prevByModel.get(g.model) ?? 0) : null;
      const change = compareChange(g.tokens, prevTokens);

      const effortSum = [...g.efforts.values()].reduce((acc, v) => acc + v, 0);
      const efforts = effortSum > 0
        ? [...g.efforts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([effort, weight]) => ({ effort, sharePct: round1((weight / effortSum) * 100) }))
        : [];

      return {
        rank: i + 1,
        model: g.model,
        provider: primaryProvider,
        providers: providersSorted.map(([p]) => p),
        tokens: g.tokens,
        input: g.input,
        output: g.output,
        cacheRead: g.cacheRead,
        cacheWrite: g.cacheWrite,
        reasoning: g.reasoning,
        sessions: g.sessions.size,
        events: g.events,
        sharePct: totalTokens > 0 ? round1((g.tokens / totalTokens) * 100) : 0,
        prevTokens,
        deltaPct: change.deltaPct,
        deltaKind: change.deltaKind,
        efforts,
      };
    });

    const summaryPrev = hasPrevHistory ? prevTotalTokens : null;
    const summaryChange = compareChange(totalTokens, summaryPrev);
    const inputSide = inputTokens + cacheReadTokens + cacheWriteTokens;
    const cacheHitRate = inputSide > 0 ? round1((cacheReadTokens / inputSide) * 100) : null;
    const topEntry = leaderboardEntries[0] ?? null;

    return {
      version: 1,
      horizon,
      offset,
      includeCache,
      filters,
      latestActivityMs,
      range: {
        startMs: win.startMs,
        endMs: win.endMs,
        elapsedEndMs: Math.min(now, win.endMs),
        label: win.label,
        subtitle: `${win.unitSummary} · ${includeCache ? "cache included" : "cache excluded"}`,
        hasNext: offset < 0,
      },
      summary: {
        totalTokens,
        prevTotalTokens: summaryPrev,
        deltaPct: summaryChange.deltaPct,
        deltaKind: summaryChange.deltaKind,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        cacheHitRate,
        sessions: allSessions.size,
        events,
        unmeasuredEvents,
        topModel: topEntry
          ? { model: topEntry.model, provider: topEntry.provider, tokens: topEntry.tokens, sharePct: topEntry.sharePct }
          : null,
        peakBucket,
      },
      series: {
        models: seriesModels,
        maxBucketTotal,
        maxModelBucket,
        maxCumulativeTotal,
        maxModelCumulative,
        buckets,
      },
      leaderboard: {
        totalModels: sortedGroups.length,
        entries: leaderboardEntries,
      },
      facets: {
        providers: providerFacets,
        models: modelFacets,
      },
      backfill,
    };
  } finally {
    db.close();
  }
}
