// Subscription usage in a herdr pane. Reads the same sign-ins and endpoints as the herdr-web-ui
// bridge by importing its UsageService; point HERDR_WEB_UI_DIR at a checkout if it is not at
// ~/Code/herdr-web-ui. Read only: nothing is refreshed or written.
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.env.HERDR_WEB_UI_DIR ?? join(homedir(), "Code", "herdr-web-ui");
type Report = {
  providers: Array<{
    id: string;
    key: string;
    account: string;
    plan: string | null;
    problem: string | null;
    checked_at: string;
    credits?: { label: string | null; balance: string | null; used_percent?: number | null; resets_at?: string | null } | null;
    resets?: { available: number; expires_at: string | null } | null;
    windows: Array<{ kind: string; scope: string | null; used_percent: number; resets_at: string | null; starts_at: string | null }>;
  }>;
};

async function fetchReport(): Promise<Report> {
  try {
    const res = await fetch("http://127.0.0.1:7317/api/usage", { signal: AbortSignal.timeout(800) });
    if (res.ok) return await res.json() as Report;
  } catch {}
  const { UsageService } = await import(join(root, "server", "usage.ts"));
  return await new UsageService().report() as unknown as Report;
}

const once = process.argv.includes("--once");
const POLL_MS = 60_000; // the service itself asks providers at most every 5 minutes
const color = process.stdout.isTTY || process.env.FORCE_COLOR !== undefined;
const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint("2", t);
const bold = (t: string) => paint("1", t);
const toneRemaining = (rem: number) => (rem <= 10 ? "31" : rem <= 30 ? "33" : "32");
const KIND: Record<string, string> = { session: "5h", day: "day", week: "wk", month: "mo" };

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

function render(report: Report, columns: number): string {
  const lines: string[] = [];
  const barWidth = Math.max(6, Math.min(16, columns - 30));
  for (const p of report.providers) {
    const name = p.id.charAt(0).toUpperCase() + p.id.slice(1);
    const problem = p.problem ? paint("33", ` (${p.problem})`) : "";
    lines.push(`${bold(name)}${p.plan ? dim(` ${p.plan}`) : ""}${problem}`);
    for (const w of p.windows) {
      const label = `${KIND[w.kind] ?? w.kind}${w.scope ? ` ${w.scope}` : ""}`.slice(0, 14).padEnd(14);
      const remaining = Math.max(0, 100 - Math.round(w.used_percent));
      const pct = `${remaining}%`.padStart(4);
      const reset = w.resets_at ? dim(` ↻${until(w.resets_at)}`) : "";
      lines.push(`  ${label} ${barRemaining(remaining, barWidth)} ${pct} remaining${reset}`);
    }
    if (p.credits) {
      const rem = p.credits.used_percent != null ? Math.max(0, 100 - Math.round(p.credits.used_percent)) : null;
      lines.push(`  ${(p.credits.label ?? "credits").slice(0, 14).padEnd(14)} ${p.credits.balance}${rem != null ? paint(toneRemaining(rem), ` ${rem}% remaining`) : ""}`);
    }
    if (p.resets && p.resets.available > 0) {
      lines.push(`  ${"resets".padEnd(14)} ${p.resets.available} available${p.resets.expires_at ? dim(` · expire ${until(p.resets.expires_at)}`) : ""}`);
    }
  }
  if (report.providers.length === 0) lines.push(dim("No signed-in provider found."));
  return lines.join("\n");
}

async function draw(): Promise<void> {
  const columns = process.stdout.columns ?? 80;
  let body: string;
  try { body = render(await fetchReport(), columns); } catch (error) { body = paint("31", `usage failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (once) { console.log(body); return; }
  const stamp = dim(`updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · press q or esc to close`);
  process.stdout.write(`\x1b[H\x1b[2J${body}\n\n${stamp}\n`);
}

await draw();
if (!once) {
  const timer = setInterval(() => void draw(), POLL_MS);
  process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
  process.stdout.on("resize", () => void draw());

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      const key = data.toString();
      // q, Esc, Enter, Ctrl+C
      if (key === "q" || key === "\x1b" || key === "\r" || key === "\n" || key === "\x03") {
        clearInterval(timer);
        process.exit(0);
      }
    });
  }
}
