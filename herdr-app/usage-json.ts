// JSON bridge for the desktop mod.
import { fetchDetailedReport, getCachedReport } from "../fetcher.ts";
import { accountNames, labelAccounts, readBurndowns, recordReport } from "../history.ts";
import { readModelUsage, syncModelUsage } from "../model-usage.ts";
import { formatSummary, summaryParts } from "../usage-summary.ts";

const DAY_MS = 24 * 60 * 60_000;
const mode = process.argv[2];

// --history: the current 5-hour and weekly window of each limit, from the local history.
if (mode === "--history") {
  const cached = await getCachedReport(DAY_MS, { allowPartial: true });
  const now = Date.now();
  const burndowns = labelAccounts(readBurndowns(undefined, now), accountNames(cached));
  const start = Math.min(...burndowns.map((chart) => chart.start));
  console.log(JSON.stringify({ burndowns, modelUsage: readModelUsage(start, now) }));
  process.exit(0);
}

const report = mode === "--cached"
  ? (await getCachedReport(DAY_MS)) ?? (await getCachedReport(DAY_MS, { allowPartial: true }))
  : (mode === "--refresh" ? null : await getCachedReport(180_000)) ?? await fetchDetailedReport();
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
