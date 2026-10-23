// Single-line compact usage status for herdr tab_bar_right
import { homedir } from "node:os";
import { join } from "node:path";

interface Window {
  kind: string;
  scope: string | null;
  used_percent: number;
}
interface Credits {
  label: string | null;
  balance: string | null;
  used_percent?: number | null;
}
interface Provider {
  id: string;
  plan: string | null;
  problem: string | null;
  windows: Window[];
  credits?: Credits | null;
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
    if (res.ok) return await res.json() as Report;
  } catch {}

  // 2. Fall back to direct UsageService
  try {
    const root = process.env.HERDR_WEB_UI_DIR ?? join(homedir(), "Code", "herdr-web-ui");
    const { UsageService } = await import(join(root, "server", "usage.ts"));
    const service = new UsageService();
    return await service.report() as Report;
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

  // Find most relevant window (session first, then week, then max)
  const session = p.windows.find(w => w.kind === "session");
  const week = p.windows.find(w => w.kind === "week");
  const primary = session ?? week ?? p.windows[0];

  if (!primary && !p.credits) continue;

  // Inverted to % remaining (allowance left)
  const remaining = primary ? Math.max(0, 100 - Math.round(primary.used_percent)) : null;
  const pct = remaining != null ? `${remaining}%` : "";
  let extra = "";
  if (p.credits && p.credits.used_percent != null) {
    const extraRemaining = Math.max(0, 100 - Math.round(p.credits.used_percent));
    extra = ` (Extra ${extraRemaining}%)`;
  }
  parts.push(`${name} ${pct}${extra}`.trim());
}

if (parts.length > 0) {
  console.log(parts.join(" · "));
}
