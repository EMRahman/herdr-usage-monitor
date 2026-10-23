// Single-line compact usage status for herdr tab_bar_right
import { homedir } from "node:os";
import { join } from "node:path";
import { getCachedReport } from "./fetcher.ts";

const SHORT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "AGY",
  grok: "Grok",
  copilot: "Copilot",
};

// 1. Fast path: check warm cache
const cached = await getCachedReport(300_000);
if (cached) {
  const parts: string[] = [];

  // Claude 5h
  if (cached.claude) {
    const s = cached.claude.windows.find(w => w.label.includes("5h")) ?? cached.claude.windows[0];
    if (s) {
      parts.push(`Claude ${Math.max(0, 100 - Math.round(s.used_percent))}%`);
    }
  }

  // Codex 5h
  if (cached.codex) {
    const s = cached.codex.windows.find(w => w.label.includes("5h")) ?? cached.codex.windows[0];
    if (s) {
      parts.push(`Codex ${Math.max(0, 100 - Math.round(s.used_percent))}%`);
    }
  }

  // AGY highest 5h
  if (cached.antigravity) {
    const fiveHourValues: number[] = [];
    for (const g of cached.antigravity.groups || []) {
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

  if (parts.length > 0) {
    console.log(parts.join(" · "));
    process.exit(0);
  }
}

// 2. Fallback path if cache is cold
async function getReport() {
  try {
    const res = await fetch("http://127.0.0.1:7317/api/usage", { signal: AbortSignal.timeout(600) });
    if (res.ok) return await res.json() as any;
  } catch {}

  try {
    const root = process.env.HERDR_WEB_UI_DIR ?? join(homedir(), "Code", "herdr-web-ui");
    const { UsageService } = await import(join(root, "server", "usage.ts"));
    return await new UsageService().report();
  } catch {}

  return null;
}

const report = await getReport();
if (!report || !report.providers?.length) {
  process.exit(0);
}

const parts: string[] = [];
for (const p of report.providers) {
  const name = SHORT_NAMES[p.id] ?? (p.id.charAt(0).toUpperCase() + p.id.slice(1));
  if (p.problem === "expired") {
    parts.push(`${name}: auth expired`);
    continue;
  }

  if (p.id === "antigravity") {
    const sessionWindows = p.windows.filter((w: any) => w.kind === "session");
    if (sessionWindows.length > 0) {
      const highest = Math.max(...sessionWindows.map((w: any) => Math.max(0, 100 - Math.round(w.used_percent))));
      parts.push(`AGY ${highest}%`);
    }
    continue;
  }

  const sessionWindow = p.windows.find((w: any) => w.kind === "session") ?? p.windows[0];
  if (!sessionWindow) continue;

  const remaining = Math.max(0, 100 - Math.round(sessionWindow.used_percent));
  parts.push(`${name} ${remaining}%`);
}

if (parts.length > 0) {
  console.log(parts.join(" · "));
}
