// Single-line compact usage status for herdr tab_bar_right
import { homedir } from "node:os";
import { join } from "node:path";

interface Window {
  kind: string;
  scope: string | null;
  used_percent: number;
}
interface Provider {
  id: string;
  plan: string | null;
  problem: string | null;
  windows: Window[];
}
interface Report {
  providers: Provider[];
}

const SHORT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "AGY",
  grok: "Grok",
  copilot: "Copilot",
};

async function getReport(): Promise<Report | null> {
  // 1. Try fast local web-ui server (runs on 7317 by default)
  try {
    const res = await fetch("http://127.0.0.1:7317/api/usage", { signal: AbortSignal.timeout(600) });
    if (res.ok) return (await res.json()) as Report;
  } catch {}

  // 2. Fall back to direct UsageService
  try {
    const root = process.env.HERDR_WEB_UI_DIR ?? join(homedir(), "Code", "herdr-web-ui");
    const { UsageService } = await import(join(root, "server", "usage.ts"));
    const service = new UsageService();
    return (await service.report()) as Report;
  } catch {}

  return null;
}

const report = await getReport();
if (!report || !report.providers.length) {
  process.exit(0);
}

const parts: string[] = [];
for (const p of report.providers) {
  const name = SHORT_NAMES[p.id] ?? (p.id.charAt(0).toUpperCase() + p.id.slice(1));
  if (p.problem === "expired") {
    parts.push(`${name}: auth expired`);
    continue;
  }

  // Antigravity: highest of the 5-hour limits % remaining
  if (p.id === "antigravity") {
    let highest5h: number | null = null;

    try {
      const cachePath = "/tmp/herdr-agy-usage.json";
      const file = Bun.file(cachePath);
      if (await file.exists()) {
        const agyJson = JSON.parse(await file.text());
        const fiveHourRemValues: number[] = [];
        for (const g of agyJson.groups || []) {
          for (const b of g.buckets || []) {
            if (b.window === "5h" || b.id?.includes("5h") || b.name?.includes("Five Hour")) {
              fiveHourRemValues.push(Math.round(b.remaining_fraction * 100));
            }
          }
        }
        if (fiveHourRemValues.length > 0) {
          highest5h = Math.max(...fiveHourRemValues);
        }
      }
    } catch {}

    // Fallback if cache not found: check report session windows
    if (highest5h === null) {
      const sessionWindows = p.windows.filter((w) => w.kind === "session");
      if (sessionWindows.length > 0) {
        highest5h = Math.max(...sessionWindows.map((w) => Math.max(0, 100 - Math.round(w.used_percent))));
      }
    }

    if (highest5h !== null) {
      parts.push(`AGY ${highest5h}%`);
    }
    continue;
  }

  // Claude and Codex (and others): strictly the 5-hour session window
  const sessionWindow = p.windows.find((w) => w.kind === "session") ?? p.windows[0];
  if (!sessionWindow) continue;

  const remaining = Math.max(0, 100 - Math.round(sessionWindow.used_percent));
  parts.push(`${name} ${remaining}%`);
}

if (parts.length > 0) {
  console.log(parts.join(" · "));
}
