// Single-line compact usage status for herdr tab_bar_right
import { fetchDetailedReport, getCachedReport } from "./fetcher.ts";

import { formatTabBar } from "./usage-summary.ts";

// 1. Fast path: check warm cache (< 5 minutes, complete or fast)
let report = await getCachedReport(300_000, { allowFast: true });
if (report) {
  const line = formatTabBar(report);
  if (line) {
    console.log(line);
    process.exit(0);
  }
}

// 2. Cold cache fallback: bounded fast direct fetch (stays well under Herdr's 2s command timeout)
report = await fetchDetailedReport({ fast: true }).catch(() => null);
if (!report) {
  report = await getCachedReport(24 * 3600_000, { allowFast: true });
}

if (report) {
  const line = formatTabBar(report);
  if (line) {
    console.log(line);
  }
}
process.exit(0);
