// JSON bridge for the desktop mod.
import { fetchDetailedReport, getCachedReport } from "../fetcher.ts";
import { accountNames, burndowns, labelAccounts, readHistory, recordReport } from "../history.ts";
import { formatSummary, summaryParts } from "../usage-summary.ts";

const DAY_MS = 24 * 60 * 60_000;
const mode = process.argv[2];

// --history: the current 5-hour and weekly window of each limit, from the local history.
if (mode === "--history") {
  const cached = await getCachedReport(DAY_MS, { allowPartial: true });
  console.log(JSON.stringify({ burndowns: labelAccounts(burndowns(readHistory()), accountNames(cached)) }));
  process.exit(0);
}

const report = mode === "--cached"
  ? (await getCachedReport(DAY_MS)) ?? (await getCachedReport(DAY_MS, { allowPartial: true }))
  : (mode === "--refresh" ? null : await getCachedReport(180_000)) ?? await fetchDetailedReport();
// Whoever refreshed the cache, its new figures go into the history once.
if (report) recordReport(report);
const parts = report ? summaryParts(report) : [];

console.log(JSON.stringify({
  report,
  summary: formatSummary(parts),
  parts,
}));
