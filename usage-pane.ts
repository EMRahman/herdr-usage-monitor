// Subscription usage in a herdr pane or modal popup.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

const root = process.env.HERDR_WEB_UI_DIR ?? join(homedir(), "Code", "herdr-web-ui");
const AGY_CACHE_FILE = "/tmp/herdr-agy-usage.json";

interface CodexCreditItem {
  id: string;
  title: string;
  status: string;
  granted_at: string;
  expires_at: string;
  description?: string;
}

interface DetailedCodex {
  account: string;
  plan: string;
  windows: Array<{ label: string; used_percent: number; resets_at: string | null }>;
  resets: {
    available: number;
    items: CodexCreditItem[];
  };
}

interface DetailedClaude {
  account: string;
  plan: string;
  windows: Array<{ label: string; used_percent: number; resets_at: string | null }>;
  extra_usage?: {
    used: string;
    limit: string;
    balance_left?: string;
    used_percent: number;
  } | null;
}

interface AgyBucket {
  label: string;
  remaining_percent: number;
  resets_at: string | null;
  description?: string;
}

interface DetailedAgy {
  account: string;
  tier?: string;
  policy?: string;
  groups: Array<{
    name: string;
    description?: string;
    models?: string;
    buckets: AgyBucket[];
  }>;
}

interface GenericProvider {
  id: string;
  account: string;
  plan: string | null;
  windows: Array<{ kind: string; scope: string | null; used_percent: number; resets_at: string | null }>;
  credits?: { label: string | null; balance: string | null; used_percent?: number | null } | null;
  resets?: { available: number; expires_at: string | null } | null;
  problem: string | null;
}

interface FullReport {
  claude?: DetailedClaude | null;
  codex?: DetailedCodex | null;
  antigravity?: DetailedAgy | null;
  others: GenericProvider[];
}

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

async function fetchDetailedReport(): Promise<FullReport> {
  const { USAGE_PROVIDERS } = await import(join(root, "server", "usage.ts"));

  const ctx = {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    async fetch(url: string, init: RequestInit) { return fetch(url, init); },
    async keychain(service: string, account?: string) {
      const child = Bun.spawn(["security", "find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"], { stdout: "pipe", stderr: "ignore" });
      const val = (await new Response(child.stdout).text()).trim();
      if ((await child.exited) === 0 && val) return { status: "found" as const, value: val };
      return { status: "missing" as const };
    },
    async run() { return null; },
    now: () => Date.now(),
  };

  const [claudeSignIns, codexSignIns, agySignIns] = await Promise.all([
    USAGE_PROVIDERS.find(p => p.id === "claude")?.signIns(ctx).catch(() => []) ?? [],
    USAGE_PROVIDERS.find(p => p.id === "codex")?.signIns(ctx).catch(() => []) ?? [],
    USAGE_PROVIDERS.find(p => p.id === "antigravity")?.signIns(ctx).catch(() => []) ?? [],
  ]);

  const report: FullReport = { others: [] };

  // Fetch Claude
  const claudePromise = (async () => {
    const s = claudeSignIns[0];
    if (!s) return;
    const res = await fetch("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", {
      headers: { authorization: `Bearer ${s.token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-cli/2.1.0 (external, cli)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;
    const body = await res.json() as any;

    const windows: DetailedClaude["windows"] = [];
    if (body.five_hour && body.five_hour.utilization != null) {
      windows.push({ label: "5h session", used_percent: body.five_hour.utilization, resets_at: body.five_hour.resets_at });
    }
    if (body.seven_day && body.seven_day.utilization != null) {
      windows.push({ label: "7d weekly", used_percent: body.seven_day.utilization, resets_at: body.seven_day.resets_at });
    }
    if (body.seven_day_opus && body.seven_day_opus.utilization != null) {
      windows.push({ label: "7d Opus", used_percent: body.seven_day_opus.utilization, resets_at: body.seven_day_opus.resets_at });
    }
    if (body.seven_day_sonnet && body.seven_day_sonnet.utilization != null) {
      windows.push({ label: "7d Sonnet", used_percent: body.seven_day_sonnet.utilization, resets_at: body.seven_day_sonnet.resets_at });
    }

    let extra_usage = null;
    if (body.extra_usage?.is_enabled || body.spend?.enabled) {
      const curr = body.extra_usage?.currency === "GBP" ? "£" : "$";
      const usedMinor = body.spend?.used?.amount_minor ?? body.extra_usage?.used_credits ?? 0;
      const limitMinor = body.spend?.limit?.amount_minor ?? body.extra_usage?.monthly_limit ?? 0;
      const divisor = 100;
      const usedStr = `${curr}${(usedMinor / divisor).toFixed(2)}`;
      const limitStr = `${curr}${(limitMinor / divisor).toFixed(2)}`;
      const leftStr = `${curr}${Math.max(0, (limitMinor - usedMinor) / divisor).toFixed(2)}`;
      const usedPct = body.extra_usage?.utilization ?? body.spend?.percent ?? 0;
      extra_usage = {
        used: usedStr,
        limit: limitStr,
        balance_left: leftStr,
        used_percent: usedPct,
      };
    }

    report.claude = {
      account: s.account?.label ?? "default",
      plan: s.plan ?? "pro",
      windows,
      extra_usage,
    };
  })().catch(() => {});

  // Fetch Codex
  const codexPromise = (async () => {
    const s = codexSignIns[0];
    if (!s) return;
    const [usageRes, creditsRes] = await Promise.all([
      fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: { authorization: `Bearer ${s.token}`, accept: "application/json", ...(s.chatgptAccount ? { "chatgpt-account-id": s.chatgptAccount } : {}) },
        signal: AbortSignal.timeout(4000),
      }),
      fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
        headers: { authorization: `Bearer ${s.token}`, accept: "application/json", ...(s.chatgptAccount ? { "chatgpt-account-id": s.chatgptAccount } : {}) },
        signal: AbortSignal.timeout(4000),
      }).catch(() => null),
    ]);
    if (!usageRes.ok) return;
    const body = await usageRes.json() as any;
    const creditsBody = creditsRes && creditsRes.ok ? await creditsRes.json() as any : null;

    const rate = body.rate_limit ?? {};
    const windows: DetailedCodex["windows"] = [];
    if (rate.primary_window && rate.primary_window.used_percent != null) {
      const resetIso = rate.primary_window.reset_at ? new Date(rate.primary_window.reset_at * 1000).toISOString() : null;
      windows.push({ label: "5h session", used_percent: rate.primary_window.used_percent, resets_at: resetIso });
    }
    if (rate.secondary_window && rate.secondary_window.used_percent != null) {
      const resetIso = rate.secondary_window.reset_at ? new Date(rate.secondary_window.reset_at * 1000).toISOString() : null;
      windows.push({ label: "Weekly", used_percent: rate.secondary_window.used_percent, resets_at: resetIso });
    }

    const availableResets = body.rate_limit_reset_credits?.available_count ?? 0;
    const rawCredits = Array.isArray(creditsBody?.credits) ? creditsBody.credits : [];
    const items: CodexCreditItem[] = rawCredits
      .filter((c: any) => c.status === "available")
      .map((c: any) => ({
        id: c.id,
        title: c.title ?? "Rate limit reset",
        status: c.status,
        granted_at: c.granted_at,
        expires_at: c.expires_at,
        description: c.description,
      }))
      .sort((a: any, b: any) => Date.parse(a.expires_at) - Date.parse(b.expires_at));

    report.codex = {
      account: s.account?.label ?? body.email ?? "default",
      plan: s.plan ?? body.plan_type ?? "plus",
      windows,
      resets: {
        available: availableResets,
        items,
      },
    };
  })().catch(() => {});

  // Fetch Antigravity (checks cached agy output, or agy -p "/usage" --output-format json, or fallback API)
  const agyPromise = (async () => {
    const s = agySignIns[0];
    const account = s?.account?.label ?? "default";

    // 1. Try reading recent agy cache
    let agyData: any = null;
    try {
      if (existsSync(AGY_CACHE_FILE)) {
        const stat = await Bun.file(AGY_CACHE_FILE).stat();
        if (Date.now() - stat.mtimeMs < 120_000) {
          agyData = JSON.parse(await Bun.file(AGY_CACHE_FILE).text());
        }
      }
    } catch {}

    // 2. If not cached, try executing agy -p "/usage" --output-format json
    if (!agyData) {
      try {
        const child = Bun.spawn(["agy", "-p", "/usage", "--output-format", "json"], { stdout: "pipe", stderr: "ignore" });
        const timer = setTimeout(() => { try { child.kill(); } catch {} }, 4500);
        const text = await new Response(child.stdout).text();
        clearTimeout(timer);
        if ((await child.exited) === 0 && text) {
          const parsed = JSON.parse(text);
          if (parsed.command?.data?.groups) {
            agyData = parsed.command.data;
            try { writeFileSync(AGY_CACHE_FILE, JSON.stringify(agyData)); } catch {}
          }
        }
      } catch {}
    }

    if (agyData?.groups) {
      const groups = agyData.groups.map((g: any) => {
        const models = g.description?.startsWith("Models within this group:")
          ? g.description.replace(/^Models within this group:\s*/i, "")
          : undefined;
        const groupDesc = !g.description?.startsWith("Models within this group:") ? g.description : undefined;
        const buckets: AgyBucket[] = (g.buckets ?? []).map((b: any) => {
          const remFraction = b.remaining_fraction ?? b.remainingFraction ?? 0;
          return {
            label: b.name ?? (b.window === "5h" ? "5h limit" : b.window === "weekly" ? "Weekly limit" : "Limit"),
            remaining_percent: Math.round(remFraction * 100),
            resets_at: b.reset_time ?? b.resetTime ?? null,
            description: b.description,
          };
        });
        return {
          name: g.name,
          models,
          description: groupDesc,
          buckets,
        };
      });

      report.antigravity = {
        account,
        policy: agyData.description,
        groups,
      };
      return;
    }

    // 3. Fallback to direct API if agy CLI wasn't available
    if (!s) return;
    const init = {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}`, accept: "application/json", "content-type": "application/json", "user-agent": "antigravity" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    };
    let res = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init).catch(() => null);
    if (!res || !res.ok) {
      res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init).catch(() => null);
    }
    if (!res || !res.ok) return;
    const body = await res.json() as any;
    const groupsRaw = Array.isArray(body.groups) ? body.groups : [];
    const groups = groupsRaw.map((g: any) => ({
      name: g.displayName ?? "Model group",
      models: g.description?.replace(/^Models within this group:\s*/i, "") ?? "",
      buckets: (g.buckets ?? []).map((b: any) => ({
        label: b.window === "5h" ? "5h limit" : b.window === "weekly" ? "Weekly limit" : (b.displayName ?? "Limit"),
        remaining_percent: Math.round((b.remainingFraction ?? 0) * 100),
        resets_at: b.resetTime ?? null,
        description: b.description,
      })),
    }));

    report.antigravity = {
      account,
      policy: body.description,
      groups,
    };
  })().catch(() => {});

  // Query other providers from the local bridge API cache if present
  const othersPromise = (async () => {
    try {
      const res = await fetch("http://127.0.0.1:7317/api/usage", { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        const data = await res.json() as { providers: any[] };
        for (const p of data.providers) {
          if (!["claude", "codex", "antigravity"].includes(p.id)) {
            report.others.push(p);
          }
        }
      }
    } catch {}
  })().catch(() => {});

  await Promise.all([claudePromise, codexPromise, agyPromise, othersPromise]);
  return report;
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
    // Rate limit reset credits with full expiry breakdown
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
      if (g.description) {
        lines.push(`    ${dim(g.description)}`);
      }
    }
    if (agy.policy) {
      lines.push(`  ${dim(agy.policy)}`);
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

async function draw(): Promise<void> {
  const columns = process.stdout.columns ?? 80;
  let body: string;
  try {
    const rep = await fetchDetailedReport();
    body = render(rep, columns);
  } catch (error) {
    body = paint("31", `usage failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (once) {
    console.log(body);
    return;
  }

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
      if (key === "q" || key === "\x1b" || key === "\r" || key === "\n" || key === "\x03") {
        clearInterval(timer);
        process.exit(0);
      }
    });
  }
}
