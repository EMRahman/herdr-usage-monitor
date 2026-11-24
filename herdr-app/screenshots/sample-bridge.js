// Stands in for the mod's bridge.js while capture.ts takes screenshots: every reading is made
// up here, and no provider, credential, cache or history file is read. It answers the bridge's
// calls the same way: the report with --cached or no flag, the burndown charts with --history.
//
// SHOT_TIME is the sample's clock. capture.ts freezes the mod's clock at the same moment, so
// "Updated", the reset times and the charts' current-time marker agree across every image.
export const SHOT_TIME = "2026-11-24T09:26:00Z";

const hour = 3_600_000;
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
  timestamp: now,
  claude: {
    plan: "Pro", windows: windows("claude"),
    extra_usage: { used: "£8.16", limit: "£15.39", balance_left: "£7.23", used_percent: 53 },
  },
  codex: {
    plan: "Plus", windows: windows("codex"),
    resets: { available: 1, items: [{ title: "Full reset (Weekly + 5 hr)", expires_at: iso(now + 8 * 24 * hour) }] },
  },
  antigravity: { groups: [
    { name: gemini, models: "Gemini 4 Neon, Gemini 4 Hydrogen", buckets: buckets(gemini) },
    { name: shared, models: "Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B", buckets: buckets(shared) },
  ] },
};

if (import.meta.main) {
  console.log(JSON.stringify(process.argv.includes("--history") ? { burndowns } : { report, parts: [
    { name: "Claude", remaining: 62 }, { name: "Codex", remaining: 82 }, { name: "AGY", remaining: 64 },
  ] }));
}
