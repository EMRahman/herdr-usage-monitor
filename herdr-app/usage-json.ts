// JSON bridge for the desktop mod.
import { fetchDetailedReport, getCachedReport } from "../fetcher.ts";
import { readHistorical, type Horizon } from "../historical.ts";
import { accountNames, labelAccounts, readBurndowns, recordReport } from "../history.ts";
import { readModelUsage, syncModelUsage } from "../model-usage.ts";
import { formatSummary, summaryParts } from "../usage-summary.ts";

const DAY_MS = 24 * 60 * 60_000;
const mode = process.argv[2];

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

// --history: the current 5-hour and weekly window of each limit, from the local history.
if (mode === "--history") {
  const cached = await getCachedReport(DAY_MS, { allowPartial: true });
  const now = Date.now();
  const burndowns = labelAccounts(readBurndowns(undefined, now), accountNames(cached));
  const start = Math.min(...burndowns.map((chart) => chart.start));
  console.log(JSON.stringify({ burndowns, modelUsage: readModelUsage(start, now) }));
  process.exit(0);
}

// --historical: aggregated local model & token usage across D / W / M / Y horizons.
if (mode === "--historical") {
  const now = Date.now();
  const shouldSync = flagValue("sync") === "1";
  let backfill = { pendingFiles: 0, totalFiles: 0 };
  if (shouldSync) {
    const stats = await syncModelUsage(undefined, undefined, now, { budgetMs: 3_500 }).catch((error) => {
      console.warn("Couldn't sync model usage:", error instanceof Error ? error.message : error);
      return null;
    });
    if (stats) backfill = { pendingFiles: stats.pendingFiles, totalFiles: stats.totalFiles };
  }
  const offsetRaw = Number(flagValue("offset") ?? "0");
  const payload = readHistorical({
    horizon: (flagValue("horizon") ?? "m") as Horizon,
    offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
    provider: flagValue("provider") ?? "all",
    model: flagValue("model") ?? "all",
    includeCache: flagValue("cache") !== "0",
    now,
  }, undefined, backfill);
  console.log(JSON.stringify(payload));
  process.exit(0);
}

// A recent cache stands in for a fetch only if it says when each provider was read. A writer
// that leaves read_at out (an older build still running) would otherwise keep the cache fresh
// while nothing reaches the history.
const recent = async () => {
  const cached = await getCachedReport(180_000);
  return cached?.read_at && Object.keys(cached.read_at).length ? cached : null;
};

const report = mode === "--cached"
  ? (await getCachedReport(DAY_MS)) ?? (await getCachedReport(DAY_MS, { allowPartial: true }))
  : (mode === "--refresh" ? null : await recent()) ?? await fetchDetailedReport();
try {
  // Whoever refreshed the cache, its new figures go into the history once.
  if (report) recordReport(report);
} catch (error) {
  console.warn("Couldn't record allowance history:", error instanceof Error ? error.message : error);
}
if (mode !== "--cached") {
  await syncModelUsage().catch((error) => {
    console.warn("Couldn't sync model usage:", error instanceof Error ? error.message : error);
  });
}
const parts = report ? summaryParts(report) : [];

console.log(JSON.stringify({
  report,
  summary: formatSummary(parts),
  parts,
}));
