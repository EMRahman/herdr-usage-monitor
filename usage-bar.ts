// Single-line compact usage status for herdr tab_bar_right
import { fetchDetailedReport, getCachedReport, type FullReport } from "./fetcher.ts";

const SHORT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "AGY",
  grok: "Grok",
  copilot: "Copilot",
  opencode: "OpenCode",
};

function formatTabBar(report: FullReport): string {
  const parts: string[] = [];

  // Claude 5h
  if (report.claude) {
    const s = report.claude.windows.find((w) => w.label.includes("5h")) ?? report.claude.windows[0];
    if (s) {
      parts.push(`Claude ${Math.max(0, 100 - Math.round(s.used_percent))}%`);
    }
  }

  // Codex 5h
  if (report.codex) {
    const s = report.codex.windows.find((w) => w.label.includes("5h")) ?? report.codex.windows[0];
    if (s) {
      parts.push(`Codex ${Math.max(0, 100 - Math.round(s.used_percent))}%`);
    }
  }

  // AGY highest 5h
  if (report.antigravity) {
    const fiveHourValues: number[] = [];
    for (const g of report.antigravity.groups || []) {
      for (const b of g.buckets || []) {
        if (b.label.includes("5h") || b.label.includes("Five Hour")) {
          fiveHourValues.push(b.remaining_percent);
        }
      }
    }
    if (fiveHourValues.length > 0) {
      parts.push(`AGY ${Math.max(...fiveHourValues)}%`);
    }
  }

  // Fallback to secondary providers if none of the primary 5h providers are active
  if (parts.length === 0 && report.others?.length) {
    for (const p of report.others) {
      const name = SHORT_NAMES[p.id] ?? p.id.charAt(0).toUpperCase() + p.id.slice(1);
      if (p.problem === "expired") {
        parts.push(`${name}: auth expired`);
        continue;
      }
      const sessionWindow = p.windows.find((w) => w.kind === "session") ?? p.windows[0];
      if (!sessionWindow) continue;
      const remaining = Math.max(0, 100 - Math.round(sessionWindow.used_percent));
      parts.push(`${name} ${remaining}%`);
    }
  }

  return parts.join(" · ");
}

// 1. Fast path: check warm cache (< 5 minutes)
let report = await getCachedReport(300_000);
if (report) {
  const line = formatTabBar(report);
  if (line) {
    console.log(line);
    process.exit(0);
  }
}

// 2. Cold cache fallback: fast direct fetch (stays well under Herdr's 2s command timeout)
report = await fetchDetailedReport({ fast: true }).catch(() => null);
if (!report) {
  report = await getCachedReport(24 * 3600_000);
}

if (report) {
  const line = formatTabBar(report);
  if (line) {
    console.log(line);
  }
}
