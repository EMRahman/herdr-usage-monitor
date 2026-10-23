// Subscription usage in a herdr modal popup or pane.
import {
  fetchDetailedReport,
  getCachedReport,
  saveCachedReport,
  type FullReport,
} from "./fetcher.ts";

const once = process.argv.includes("--once");
const POLL_MS = 60_000;
const color = process.stdout.isTTY || process.env.FORCE_COLOR !== undefined;
const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint("2", t);
const bold = (t: string) => paint("1", t);
const toneRemaining = (rem: number) => (rem <= 10 ? "31" : rem <= 30 ? "33" : "32");

function barRemaining(rem: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((rem / 100) * width)));
  return paint(toneRemaining(rem), "█".repeat(filled)) + dim("░".repeat(width - filled));
}

function until(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.round(h / 24)}d`;
}

function formatAtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return timeStr;
  const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${dateStr}, ${timeStr}`;
}

function render(report: FullReport, columns: number): string {
  const lines: string[] = [];
  const barWidth = Math.max(8, Math.min(16, columns - 32));

  // 1. CLAUDE
  if (report.claude) {
    const c = report.claude;
    lines.push(`${bold("Claude")} ${dim(c.plan)}${c.account ? dim(` · ${c.account}`) : ""}`);
    for (const w of c.windows) {
      const rem = Math.max(0, 100 - Math.round(w.used_percent));
      const pct = `${rem}%`.padStart(4);
      const timeR = until(w.resets_at);
      const exactTime = formatAtTime(w.resets_at);
      const reset = w.resets_at ? dim(` ↻${timeR}${exactTime ? ` (${exactTime})` : ""}`) : "";
      lines.push(`  ${w.label.padEnd(14)} ${barRemaining(rem, barWidth)} ${pct} remaining${reset}`);
    }
    if (c.extra_usage) {
      const rem = Math.max(0, 100 - Math.round(c.extra_usage.used_percent));
      const leftPart = c.extra_usage.balance_left ? dim(` (${c.extra_usage.balance_left} left)`) : "";
      lines.push(`  ${"Extra usage".padEnd(14)} ${c.extra_usage.used} / ${c.extra_usage.limit}  ${paint(toneRemaining(rem), `${rem}% remaining`)}${leftPart}`);
    }
    lines.push("");
  }

  // 2. CODEX
  if (report.codex) {
    const cx = report.codex;
    lines.push(`${bold("Codex")} ${dim(cx.plan)}${cx.account ? dim(` · ${cx.account}`) : ""}`);
    for (const w of cx.windows) {
      const rem = Math.max(0, 100 - Math.round(w.used_percent));
      const pct = `${rem}%`.padStart(4);
      const timeR = until(w.resets_at);
      const exactTime = formatAtTime(w.resets_at);
      const reset = w.resets_at ? dim(` ↻${timeR}${exactTime ? ` (${exactTime})` : ""}`) : "";
      lines.push(`  ${w.label.padEnd(14)} ${barRemaining(rem, barWidth)} ${pct} remaining${reset}`);
    }
    if (cx.resets.available > 0 || cx.resets.items.length > 0) {
      lines.push(`  ${bold("Rate limit resets")} (${cx.resets.available} available):`);
      if (cx.resets.items.length > 0) {
        cx.resets.items.forEach((item, idx) => {
          const timeR = until(item.expires_at);
          const exactTime = formatAtTime(item.expires_at);
          lines.push(`    ${paint("36", "•")} Reset #${idx + 1}: ${item.title} ${dim("·")} expires in ${bold(timeR)} ${dim(`(${exactTime})`)}`);
        });
      } else {
        lines.push(`    ${cx.resets.available} available`);
      }
    }
    lines.push("");
  }

  // 3. ANTIGRAVITY (AGY)
  if (report.antigravity) {
    const agy = report.antigravity;
    lines.push(`${bold("Antigravity")}${agy.account ? dim(` · ${agy.account}`) : ""}`);
    for (const g of agy.groups) {
      lines.push(`  ${bold(g.name)}${g.models ? dim(` (${g.models})`) : ""}`);
      for (const b of g.buckets) {
        const rem = b.remaining_percent;
        const pct = `${rem}%`.padStart(4);
        const timeR = until(b.resets_at);
        const exactTime = formatAtTime(b.resets_at);
        const reset = b.resets_at ? dim(` ↻${timeR}${exactTime ? ` (${exactTime})` : ""}`) : "";
        lines.push(`    ${b.label.padEnd(28)} ${barRemaining(rem, barWidth)} ${pct} remaining${reset}`);
      }
    }
    lines.push("");
  }

  // 4. OTHER PROVIDERS (Cursor, Grok, Copilot)
  for (const p of report.others) {
    const name = p.id.charAt(0).toUpperCase() + p.id.slice(1);
    const problem = p.problem ? paint("33", ` (${p.problem})`) : "";
    lines.push(`${bold(name)}${p.plan ? dim(` ${p.plan}`) : ""}${p.account ? dim(` · ${p.account}`) : ""}${problem}`);
    for (const w of p.windows) {
      const KIND: Record<string, string> = { session: "5h", day: "day", week: "wk", month: "mo" };
      const label = `${KIND[w.kind] ?? w.kind}${w.scope ? ` ${w.scope}` : ""}`.slice(0, 14).padEnd(14);
      const rem = Math.max(0, 100 - Math.round(w.used_percent));
      const pct = `${rem}%`.padStart(4);
      const timeR = until(w.resets_at);
      const exactTime = formatAtTime(w.resets_at);
      const reset = w.resets_at ? dim(` ↻${timeR}${exactTime ? ` (${exactTime})` : ""}`) : "";
      lines.push(`  ${label} ${barRemaining(rem, barWidth)} ${pct} remaining${reset}`);
    }
    if (p.credits) {
      const rem = p.credits.used_percent != null ? Math.max(0, 100 - Math.round(p.credits.used_percent)) : null;
      lines.push(`  ${(p.credits.label ?? "credits").slice(0, 14).padEnd(14)} ${p.credits.balance}${rem != null ? paint(toneRemaining(rem), ` ${rem}% remaining`) : ""}`);
    }
    lines.push("");
  }

  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

let currentReport: FullReport | null = null;
let isRefreshing = false;

function draw(isRefreshingNow: boolean): void {
  const columns = process.stdout.columns ?? 80;
  if (!currentReport) {
    if (once) return;
    process.stdout.write(`\x1b[H\x1b[2JLoading subscription usage breakdown... ${paint("33", "↻ refreshing…")}\n`);
    return;
  }

  const body = render(currentReport, columns);
  if (once) {
    console.log(body);
    return;
  }

  const timeStr = currentReport.timestamp
    ? new Date(currentReport.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const status = isRefreshingNow ? ` ${paint("33", "↻ refreshing…")}` : "";
  const stamp = dim(`updated ${timeStr}${status} · press q or esc to close`);
  process.stdout.write(`\x1b[H\x1b[2J${body}\n\n${stamp}\n`);
}

async function refresh(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;
  draw(true);

  try {
    const report = await fetchDetailedReport();
    currentReport = report;
    saveCachedReport(report);
  } catch (error) {
    // Keep showing currentReport if available
    if (!currentReport) {
      process.stdout.write(`\x1b[H\x1b[2J${paint("31", `usage failed: ${error instanceof Error ? error.message : String(error)}`)}\n`);
    }
  } finally {
    isRefreshing = false;
    draw(false);
  }
}

// 1. Instant paint from cache (0 ms)
currentReport = await getCachedReport();
if (currentReport && !once) {
  draw(true); // Paint cached report immediately with "refreshing..." indicator
}

// 2. Immediate async refresh in background
if (!once) {
  void refresh();
  const timer = setInterval(() => void refresh(), POLL_MS);
  process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
  process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
  process.stdout.on("resize", () => draw(isRefreshing));

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      const key = data.toString();
      if (key === "q" || key === "\x1b" || key === "\r" || key === "\n" || key === "\x03") {
        clearInterval(timer);
        process.exit(0);
      } else if (key === "r") {
        void refresh();
      }
    });
  }
} else {
  // If run with --once, wait for fresh data if no cache, else draw cache
  if (!currentReport) {
    await refresh();
  } else {
    draw(false);
  }
}
