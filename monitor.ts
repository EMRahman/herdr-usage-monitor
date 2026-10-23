// Background poller for herdr-usage-monitor: keeps the usage cache warm every 60s
import { fetchDetailedReport, saveCachedReport } from "./fetcher.ts";

const INTERVAL_MS = 60_000;

async function tick() {
  try {
    const report = await fetchDetailedReport();
    saveCachedReport(report);
  } catch (err) {
    console.error("background monitor tick error:", err);
  }
}

// Initial fetch
await tick();

// Repeat every minute
setInterval(() => {
  void tick();
}, INTERVAL_MS);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
