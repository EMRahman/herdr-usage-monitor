// JSON bridge for the desktop mod. Provider discovery and caching stay in the monitor.
import { fetchDetailedReport, getCachedReport } from "../fetcher.ts";
import { formatTabBar, summaryParts } from "../usage-summary.ts";

const DAY_MS = 24 * 60 * 60_000;
const mode = process.argv[2];
const report = mode === "--cached"
  ? (await getCachedReport(DAY_MS)) ?? (await getCachedReport(DAY_MS, { allowFast: true }))
  : (mode === "--refresh" ? null : await getCachedReport(180_000)) ?? await fetchDetailedReport();

console.log(JSON.stringify({
  report,
  summary: report ? formatTabBar(report) : "",
  parts: report ? summaryParts(report) : [],
}));
