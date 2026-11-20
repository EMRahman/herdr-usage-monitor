// JSON bridge for the desktop mod.
import { fetchDetailedReport, getCachedReport } from "../fetcher.ts";
import { formatSummary, summaryParts } from "../usage-summary.ts";

const DAY_MS = 24 * 60 * 60_000;
const mode = process.argv[2];
const report = mode === "--cached"
  ? (await getCachedReport(DAY_MS)) ?? (await getCachedReport(DAY_MS, { allowPartial: true }))
  : (mode === "--refresh" ? null : await getCachedReport(180_000)) ?? await fetchDetailedReport();
const parts = report ? summaryParts(report) : [];

console.log(JSON.stringify({
  report,
  summary: formatSummary(parts),
  parts,
}));
