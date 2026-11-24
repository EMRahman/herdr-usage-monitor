import type { FullReport } from "./fetcher.ts";

const SHORT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "AGY",
  grok: "Grok",
  copilot: "Copilot",
  opencode: "OpenCode",
};

/** One provider in the compact summary: its % remaining, or a problem note instead. */
export interface SummaryPart {
  name: string;
  remaining: number | null;
  note?: string;
}

export function summaryParts(report: FullReport): SummaryPart[] {
  const parts: SummaryPart[] = [];

  // Claude 5h
  if (report.claude) {
    const s = report.claude.windows.find((w) => w.label.includes("5h")) ?? report.claude.windows[0];
    if (s) {
      parts.push({ name: "Claude", remaining: Math.max(0, 100 - Math.round(s.used_percent)) });
    }
  }

  // Codex 5h
  if (report.codex) {
    const s = report.codex.windows.find((w) => w.label.includes("5h")) ?? report.codex.windows[0];
    if (s) {
      parts.push({ name: "Codex", remaining: Math.max(0, 100 - Math.round(s.used_percent)) });
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
      parts.push({ name: "AGY", remaining: Math.max(...fiveHourValues) });
    }
  }

  // Fallback to secondary providers if none of the primary 5h providers are active
  if (parts.length === 0 && report.others?.length) {
    for (const p of report.others) {
      const name = SHORT_NAMES[p.id] ?? p.id.charAt(0).toUpperCase() + p.id.slice(1);
      if (p.problem === "expired") {
        parts.push({ name, remaining: null, note: "auth expired" });
        continue;
      }
      const sessionWindow = p.windows.find((w) => w.kind === "session") ?? p.windows[0];
      if (!sessionWindow) continue;
      parts.push({ name, remaining: Math.max(0, 100 - Math.round(sessionWindow.used_percent)) });
    }
  }

  return parts;
}

export function formatSummary(parts: SummaryPart[]): string {
  return parts
    .map((part) => (part.note ? `${part.name}: ${part.note}` : `${part.name} ${part.remaining}%`))
    .join(" · ");
}
