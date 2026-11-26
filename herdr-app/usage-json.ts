// JSON bridge for the desktop mod.
import { fetchDetailedReport, getCachedReport, getRateLimitsAsync } from "../src/fetcher.ts";
import { readHistorical, type Horizon } from "../src/history/historical.ts";
import { accountId, accountNames, labelAccounts, readBurndowns, recordReport } from "../src/history/burndown.ts";
import { latestModelActivity, readPrompts, readModelUsage, syncModelUsage } from "../src/history/model-usage.ts";
import { planProviderRefreshes } from "../src/refresh-policy.ts";
import { formatSummary, summaryParts } from "../src/usage-summary.ts";

const DAY_MS = 24 * 60 * 60_000;
const mode = process.argv[2];

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

if (mode === "--prompts") {
  const payload = await readPrompts({
    from: Number(flagValue("from")),
    to: Number(flagValue("to")),
    mode: flagValue("view") === "burndown" ? "burndown" : "usage",
    provider: flagValue("provider"),
    group: flagValue("group"),
    bucket: flagValue("bucket"),
    model: flagValue("model"),
    includeCache: flagValue("cache") !== "0",
  });
  console.log(JSON.stringify(payload));
  process.exit(0);
}

// --history: the current 5-hour and weekly window of each limit, from the local history.
if (mode === "--history") {
  const cached = await getCachedReport(DAY_MS, { allowPartial: true });
  const now = Date.now();
  const burndowns = labelAccounts(readBurndowns(undefined, now), accountNames(cached));
  const activeAccounts = Object.fromEntries([
    ["claude", accountId(cached?.claude?.account)], ["codex", accountId(cached?.codex?.account)],
    ["antigravity", accountId(cached?.antigravity?.account)],
    ...(cached?.others ?? []).map((provider) => [provider.id, accountId(provider.account)]),
  ]);
  const start = Math.min(...burndowns.map((chart) => chart.start));
  console.log(JSON.stringify({ burndowns, activeAccounts, modelUsage: readModelUsage(start, now) }));
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

if (mode !== "--cached") {
  await syncModelUsage().catch((error) => {
    console.warn("Couldn't sync model usage:", error instanceof Error ? error.message : error);
  });
}

const force = mode === "--refresh";
const now = Date.now();
const activity = latestModelActivity();

// A recent cache stands in for a fetch when every provider is still within its adaptive TTL
// (or in rate-limit cooldown) and no cached quota window has reset since the last check.
// A writer that leaves read_at out would otherwise keep the cache fresh while nothing reaches history.
const recent = async () => {
  const cached = await getCachedReport(DAY_MS, { allowPartial: true, now });
  if (!cached?.read_at || Object.keys(cached.read_at).length === 0) return null;

  const limits = await getRateLimitsAsync();
  const plan = planProviderRefreshes(cached, {
    activity,
    claudeUntil: limits.claudeUntil,
    now,
    force: false,
  });
  if (plan.any) return null;
  return { ...cached, ttl: plan.ttls };
};

const report = mode === "--cached"
  ? (await getCachedReport(DAY_MS)) ?? (await getCachedReport(DAY_MS, { allowPartial: true }))
  : (force ? null : await recent()) ?? await fetchDetailedReport({ force, activity, now });
try {
  // Whoever refreshed the cache, its new figures go into the history once.
  if (report) recordReport(report);
} catch (error) {
  console.warn("Couldn't record allowance history:", error instanceof Error ? error.message : error);
}
const parts = report ? summaryParts(report) : [];

console.log(JSON.stringify({
  report,
  summary: formatSummary(parts),
  parts,
}));
