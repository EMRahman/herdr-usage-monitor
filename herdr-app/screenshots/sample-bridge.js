// Stands in for the mod's bridge.js while capture.ts takes screenshots: every reading is made
// up here, and no provider, credential, cache or history file is read. It answers the bridge's
// calls the same way: the report with --cached or no flag, the burndown charts with --history,
// and the historical model/token graphs with --historical.
//
// SHOT_TIME is the sample's clock. capture.ts freezes the mod's clock at the same moment, so
// "Updated", the reset times and the charts' elapsed-time shading agree across every image.
export const SHOT_TIME = "2026-11-24T09:26:00Z";

const hour = 3_600_000;
const day = 24 * hour;
const session = 5 * hour;
const week = 168 * hour;
const now = Date.parse(SHOT_TIME);
const iso = (time) => new Date(time).toISOString();

// One limit's window, `elapsed` of the way through, drained to `left`: a reading every 4 minutes
// for a 5-hour window and every 2 hours for a weekly one, with weekly gaps overnight while the
// machine sleeps.
function chart(provider, label, length, elapsed, left, group) {
  const start = now - length * elapsed;
  const end = start + length;
  const reset = iso(end);
  const interval = length === session ? 4 * 60_000 : 2 * hour;
  const runs = [];
  for (let from = start; from < now; from += interval) {
    const progress = (from - start) / (now - start);
    const localHour = new Date(from).getHours();
    if (length === week && localHour >= 1 && localHour < 7 && progress < 0.92) continue;
    const used = (100 - left) * (Math.floor(progress * 19) / 18) ** 1.18;
    runs.push([from, Math.min(now, from + interval), Math.round(Math.max(left, 100 - used))]);
  }
  runs.at(-1)[2] = left;
  return { provider, group, label, length, start, end, left, reset, runs };
}

const gemini = "Gemini models";
const shared = "Claude and GPT models";
const burndowns = [
  chart("claude", "5h session", session, 0.72, 62),
  chart("claude", "7d weekly", week, 0.64, 38),
  chart("claude", "7d Opus", week, 0.64, 12),
  chart("codex", "5h session", session, 0.64, 82),
  chart("codex", "Weekly", week, 0.47, 50),
  chart("antigravity", "5h limit", session, 0.37, 64, gemini),
  chart("antigravity", "Weekly limit", week, 0.69, 76, gemini),
  chart("antigravity", "5h limit", session, 0.77, 8, shared),
  chart("antigravity", "Weekly limit", week, 0.69, 29, shared),
];

const windows = (provider) => burndowns.filter((b) => b.provider === provider)
  .map((b) => ({ label: b.label, used_percent: 100 - b.left, resets_at: b.reset }));
const buckets = (group) => burndowns.filter((b) => b.group === group)
  .map((b) => ({ label: b.label, remaining_percent: b.left, resets_at: b.reset }));

const report = {
  timestamp: now - 120_000,
  read_at: { claude: now - 120_000, codex: now - 120_000, antigravity: now - 120_000 },
  claude: {
    plan: "Pro", windows: windows("claude"),
    extra_usage: { used: "£8.16", limit: "£15.39", balance_left: "£7.23", used_percent: 53 },
    limit_resets: [{
      id: "full-reset", label: "One full limit reset (November 2026)", left: 1, total: 1,
      expires_at: iso(now + 15 * day), usable_now: true, paused: false, needs_limit: false,
    }],
    credits: { balance: "£8.99", expiring: [{ amount: "£8.98", expires_at: iso(now + 266 * day) }] },
    credits_read_at: now - 120_000,
  },
  codex: {
    plan: "Plus", windows: windows("codex"),
    resets: { available: 1, items: [{ title: "Full reset (Weekly + 5 hr)", expires_at: iso(now + 8 * day) }] },
  },
  antigravity: { groups: [
    { name: gemini, models: "Gemini 4 Neon, Gemini 4 Hydrogen", buckets: buckets(gemini) },
    { name: shared, models: "Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B", buckets: buckets(shared) },
  ] },
};

function sampleTokenCounts(total) {
  const input = Math.round(total * 0.32);
  const output = Math.round(total * 0.18);
  const cacheWrite = Math.round(total * 0.03);
  return { input, output, cacheWrite, cacheRead: total - input - output - cacheWrite };
}

function sampleHistorical() {
  const models = ["claude-opus-4-8", "gpt-6.2-sol", "gemini-4-neon", "claude-sonnet-4-6", "gemini-flash-worker"];
  const monthStart = Date.UTC(2026, 10, 1);
  const monthEnd = Date.UTC(2026, 11, 1);
  const days = 30;
  const histBuckets = [];
  let runningTotal = 0;
  const runningModel = Object.fromEntries(models.map((m) => [m, 0]));
  const totalsByModel = Object.fromEntries(models.map((m) => [m, 0]));
  let maxBucketTotal = 0;
  let maxModelBucket = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalEvents = 0;
  let peakBucket = null;

  for (let d = 1; d <= days; d += 1) {
    const startMs = monthStart + (d - 1) * day;
    const endMs = startMs + day;
    const future = d > 24;
    const byModel = {};
    const cumulativeByModel = {};
    let total = 0;
    let events = 0;
    if (!future) {
      const wave = 0.55 + 0.45 * Math.sin(d * 0.48) + (d % 7 === 0 ? 0.35 : 0);
      const weights = [0.36, 0.27, 0.19, 0.12, 0.06];
      models.forEach((name, idx) => {
        const wobble = 0.7 + 0.6 * Math.abs(Math.sin(d * (0.7 + idx * 0.3)));
        const val = Math.round(48_000_000 * wave * weights[idx] * wobble);
        byModel[name] = val;
        totalsByModel[name] += val;
        runningModel[name] += val;
        cumulativeByModel[name] = runningModel[name];
        total += val;
        if (val > maxModelBucket) maxModelBucket = val;
      });
      events = Math.round(total / 1_400_000);
      runningTotal += total;
      if (total > maxBucketTotal) maxBucketTotal = total;
      if (!peakBucket || total > peakBucket.tokens) peakBucket = { label: `Nov ${d}`, tokens: total };
      totalEvents += events;
    }
    const counts = sampleTokenCounts(total);
    totalInput += counts.input;
    totalOutput += counts.output;
    totalCacheRead += counts.cacheRead;
    totalCacheWrite += counts.cacheWrite;
    const showTick = d === 1 || (d % 5 === 1 && days - d >= 2);
    histBuckets.push({
      startMs,
      endMs,
      label: `Nov ${d}`,
      axisLabel: showTick ? `Nov ${d}` : "",
      future,
      total,
      cumulativeTotal: future ? 0 : runningTotal,
      ...counts,
      events,
      byModel,
      cumulativeByModel,
    });
  }

  const providerMap = {
    "claude-opus-4-8": "claude",
    "gpt-6.2-sol": "codex",
    "gemini-4-neon": "antigravity",
    "claude-sonnet-4-6": "claude",
    "gemini-flash-worker": "antigravity",
  };
  const deltas = [24.8, 41.2, -11.3, 8.5, -6.1];
  const entries = models.map((model, i) => {
    const tokens = totalsByModel[model];
    const counts = sampleTokenCounts(tokens);
    const deltaPct = deltas[i];
    return {
      rank: i + 1,
      model,
      provider: providerMap[model],
      providers: [providerMap[model]],
      tokens,
      ...counts,
      reasoning: Math.round(counts.output * 0.36),
      sessions: 14 - i * 2,
      events: Math.round(tokens / 1_400_000),
      sharePct: Math.round((tokens / runningTotal) * 1000) / 10,
      prevTokens: Math.round(tokens / (1 + deltaPct / 100)),
      deltaPct,
      deltaKind: deltaPct > 0 ? "up" : "down",
      efforts: i < 3 ? [{ effort: "xhigh", sharePct: 62 }, { effort: "high", sharePct: 38 }] : [],
    };
  });

  return {
    version: 1,
    horizon: "m",
    offset: 0,
    includeCache: true,
    filters: { provider: "all", model: "all" },
    latestActivityMs: now,
    range: {
      startMs: monthStart,
      endMs: monthEnd,
      elapsedEndMs: now,
      label: "November 2026",
      subtitle: "30 days · cache included",
      hasNext: false,
    },
    summary: {
      totalTokens: runningTotal,
      prevTotalTokens: Math.round(runningTotal * 0.84),
      deltaPct: 18.4,
      deltaKind: "up",
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
      reasoningTokens: Math.round(totalOutput * 0.36),
      cacheHitRate: Math.round((totalCacheRead / (totalInput + totalCacheRead + totalCacheWrite)) * 1000) / 10,
      sessions: 54,
      events: totalEvents,
      unmeasuredEvents: 0,
      topModel: { model: entries[0].model, provider: entries[0].provider, tokens: entries[0].tokens, sharePct: entries[0].sharePct },
      peakBucket,
    },
    series: {
      models,
      maxBucketTotal,
      maxModelBucket,
      maxCumulativeTotal: runningTotal,
      maxModelCumulative: Math.max(...Object.values(runningModel)),
      buckets: histBuckets,
    },
    leaderboard: { totalModels: entries.length, entries },
    facets: {
      providers: [
        { value: "claude", label: "Claude Code", tokens: totalsByModel["claude-opus-4-8"] + totalsByModel["claude-sonnet-4-6"], sessions: 22 },
        { value: "codex", label: "Codex", tokens: totalsByModel["gpt-6.2-sol"], sessions: 16 },
        { value: "antigravity", label: "Antigravity", tokens: totalsByModel["gemini-4-neon"] + totalsByModel["gemini-flash-worker"], sessions: 16 },
      ],
      models: entries.map((e) => ({ value: e.model, tokens: e.tokens, sessions: e.sessions })),
    },
    backfill: { pendingFiles: 0, totalFiles: 0 },
  };
}

if (import.meta.main) {
  const payload = process.argv.includes("--historical")
    ? sampleHistorical()
    : process.argv.includes("--history")
      ? { burndowns }
      : { report, parts: [
          { id: "claude", name: "Claude", remaining: 62 }, { id: "codex", name: "Codex", remaining: 82 },
          { id: "antigravity", name: "AGY", remaining: 64 },
        ] };
  console.log(JSON.stringify(payload));
}
