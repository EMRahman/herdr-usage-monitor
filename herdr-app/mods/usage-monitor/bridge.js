// @bun
// fetcher.ts
import { existsSync as existsSync2, mkdirSync, writeFileSync as writeFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { basename, join as join2 } from "path";

// providers.ts
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeFileSync, writeSync } from "fs";
import { open } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
var MAX_READ_BYTES = 1024 * 1024;
var COMMAND_TIMEOUT_MS = 4000;
var HTTP_TIMEOUT_MS = 3500;
var USER_AGENT = "herdr-usage-monitor";
var record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
var text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
var number = (value) => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};
var percent = (value) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
function resolveBinary(name) {
  const found = Bun.which(name);
  if (found)
    return found;
  const extraDirs = [
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  for (const dir of extraDirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate))
      return candidate;
  }
  return null;
}
function siblingDirs(home, prefix) {
  try {
    return readdirSync(home, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix)).map((entry) => join(home, entry.name)).sort();
  } catch {
    return [];
  }
}
function parseJson(source) {
  if (source === null)
    return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}
function readText(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    let size = 0;
    for (let read = 1;read > 0 && size <= MAX_READ_BYTES; size += read) {
      read = readSync(fd, buffer, size, buffer.length - size, null);
    }
    return size > MAX_READ_BYTES ? null : buffer.toString("utf8", 0, size);
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      closeSync(fd);
  }
}
async function readCapped(stream) {
  if (!stream)
    return "";
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      if (size > MAX_READ_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
function isoTime(value) {
  const n = number(value);
  if (n !== null && n > 0)
    return new Date(n < 1000000000000 ? n * 1000 : n).toISOString();
  const s = text(value);
  if (!s)
    return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
function epochMs(value) {
  const iso = isoTime(value);
  return iso === null ? null : Date.parse(iso);
}
function jwtClaims(token) {
  const payload = token.split(".")[1];
  if (!payload)
    return {};
  try {
    return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}
function jwtExpiry(token) {
  const exp = number(jwtClaims(token)["exp"]);
  return exp === null ? null : exp * 1000;
}
function kindOf(seconds, fallback) {
  if (seconds === null || seconds <= 0)
    return fallback;
  if (seconds <= 6 * 3600)
    return "session";
  if (seconds <= 36 * 3600)
    return "day";
  if (seconds <= 8 * 86400)
    return "week";
  return "month";
}
var promptedServices = new Set;
var xml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
var loginSessionJobs = 0;
async function launchctl(args, timeoutMs = COMMAND_TIMEOUT_MS) {
  const child = Bun.spawn(["launchctl", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), Math.max(50, timeoutMs));
  try {
    return await child.exited;
  } finally {
    clearTimeout(timer);
  }
}
async function readKeychainInLoginSession(service, account, timeoutMs) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function" || timeoutMs < 150)
    return null;
  const args = ["/usr/bin/security", "find-generic-password", "-s", service, ...account ? ["-a", account] : [], "-w"];
  const domain = `gui/${process.getuid()}`;
  const label = `dev.herdr.usage-monitor.keychain.${process.pid}.${Date.now()}.${++loginSessionJobs}`;
  const dir = mkdtempSync(join(tmpdir(), "herdr-usage-keychain-"));
  const fifo = join(dir, "out");
  const plist = join(dir, "job.plist");
  let pipe;
  try {
    if (Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode !== 0)
      return null;
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>StandardOutPath</key><string>${xml(fifo)}</string><key>StandardErrorPath</key><string>/dev/null</string><key>RunAtLoad</key><true/></dict></plist>
`, { mode: 384 });
    const handle = pipe = await open(fifo, "r+");
    let gaveUp = false;
    const giveUp = () => {
      gaveUp = true;
      try {
        writeSync(handle.fd, `
`);
      } catch {}
    };
    const reading = (async () => {
      const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
      let size = 0;
      let line = -1;
      while (line === -1 && size <= MAX_READ_BYTES) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0)
          break;
        size += bytesRead;
        line = buffer.subarray(0, size).indexOf(10);
      }
      return line === -1 ? null : buffer.toString("utf8", 0, line).trim();
    })().catch(() => null);
    const timer = setTimeout(giveUp, timeoutMs);
    try {
      if (await launchctl(["bootstrap", domain, plist], timeoutMs).catch(() => -1) !== 0)
        giveUp();
      const value = await reading;
      return gaveUp || !value ? null : value;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  } finally {
    await launchctl(["bootout", `${domain}/${label}`], Math.min(500, timeoutMs)).catch(() => {
      return;
    });
    await pipe?.close().catch(() => {
      return;
    });
    rmSync(dir, { recursive: true, force: true });
  }
}
async function readKeychain(service, account) {
  if (process.platform !== "darwin")
    return { status: "missing" };
  if (promptedServices.has(service))
    return { status: "locked" };
  const child = Bun.spawn(["/usr/bin/security", "find-generic-password", "-s", service, ...account ? ["-a", account] : [], "-w"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, COMMAND_TIMEOUT_MS);
  try {
    const output = await readCapped(child.stdout);
    if (output === null)
      child.kill();
    const code = await child.exited;
    clearTimeout(timer);
    if (output === null)
      return { status: "missing" };
    if (code === 0 && output.trim())
      return { status: "found", value: output.trim() };
    if (code === 44 && !timedOut)
      return { status: "missing" };
    if (code === 36 && !timedOut) {
      const gui = await readKeychainInLoginSession(service, account, COMMAND_TIMEOUT_MS);
      if (gui !== null)
        return { status: "found", value: gui };
    }
    if (timedOut)
      promptedServices.add(service);
    return { status: "locked" };
  } catch {
    return { status: "missing" };
  } finally {
    clearTimeout(timer);
  }
}
async function runCommand(argv, timeoutMs = COMMAND_TIMEOUT_MS) {
  const bin = resolveBinary(argv[0]);
  if (!bin)
    return null;
  try {
    const child = Bun.spawn([bin, ...argv.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const output = await readCapped(child.stdout);
      if (output === null)
        child.kill();
      const code = await child.exited;
      return code === 0 && output !== null ? output.trim() : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
async function fromKeychain(service, accounts, parse) {
  if (process.platform !== "darwin")
    return null;
  for (const account of accounts) {
    const found = await readKeychain(service, account);
    if (found.status === "locked")
      return "locked";
    if (found.status === "found") {
      const signIn = parse(found.value);
      if (signIn)
        return signIn;
    }
  }
  return null;
}
function keychainFound(result, source, account = null) {
  if (result === null)
    return [];
  return [result === "locked" ? { source, locked: true, account } : { ...result, account: result.account ?? account, source }];
}
function keychainOrFile(keychain, file, source, account = null) {
  const item = keychain && keychain !== "locked" ? keychain : null;
  const fileIsLater = file != null && item != null && file.expiresAt != null && item.expiresAt != null && file.expiresAt > item.expiresAt;
  if (item && !fileIsLater)
    return keychainFound(item, source, account);
  return file ? [{ ...file, account: file.account ?? account, source }] : keychainFound(keychain, source, account);
}
function unlockedSignIns(found) {
  const now = Date.now();
  const valid = found.filter((item) => !("locked" in item) && Boolean(item.token));
  return valid.sort((a, b) => {
    const aExpired = a.expiresAt !== null && a.expiresAt <= now ? 1 : 0;
    const bExpired = b.expiresAt !== null && b.expiresAt <= now ? 1 : 0;
    return aExpired - bExpired;
  });
}
function claudeAccount(path) {
  const oauth = record(record(parseJson(readText(path)))["oauthAccount"]);
  const id = text(oauth["accountUuid"]);
  return id ? { id, label: text(oauth["emailAddress"]) } : null;
}
function claudeSignIn(source) {
  const oauth = record(record(parseJson(source))["claudeAiOauth"]);
  const token = text(oauth["accessToken"]);
  return token ? { token, expiresAt: number(oauth["expiresAt"]), plan: text(oauth["subscriptionType"]) } : null;
}
async function getClaudeSignIns() {
  const home = homedir();
  const user = process.env["USER"];
  const homes = [{ source: "default", service: "Claude Code-credentials", dir: join(home, ".claude"), config: join(home, ".claude.json") }];
  const extraDirs = [process.env["CLAUDE_CONFIG_DIR"], ...siblingDirs(home, ".claude-")].filter((d) => Boolean(d));
  for (const dir of new Set(extraDirs)) {
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    homes.push({ source: dir, service: `Claude Code-credentials-${hash}`, dir, config: join(dir, ".claude.json") });
  }
  const found = await Promise.all(homes.map(async (h) => {
    const account = claudeAccount(h.config);
    const file = claudeSignIn(readText(join(h.dir, ".credentials.json")));
    const keychain = await fromKeychain(h.service, user ? [user, undefined] : [undefined], claudeSignIn);
    return keychainOrFile(keychain, file, h.source, account);
  }));
  return unlockedSignIns(found.flat());
}
function codexSignIn(source) {
  const tokens = record(record(parseJson(source))["tokens"]);
  const token = text(tokens["access_token"]);
  if (!token)
    return null;
  const claims = jwtClaims(token);
  const auth = record(claims["https://api.openai.com/auth"]);
  const workspace = text(tokens["account_id"]) ?? text(auth["chatgpt_account_id"]);
  const email = text(record(claims["https://api.openai.com/profile"])["email"]) ?? text(jwtClaims(text(tokens["id_token"]) ?? "")["email"]);
  const user = text(auth["chatgpt_user_id"]) ?? text(auth["user_id"]);
  const id = text(auth["chatgpt_account_user_id"]) ?? (user || workspace ? [user, workspace].filter(Boolean).join("__") : email);
  return {
    token,
    expiresAt: jwtExpiry(token),
    plan: text(auth["chatgpt_plan_type"]),
    chatgptAccount: workspace,
    account: id ? { id, label: email } : null
  };
}
async function getCodexSignIns() {
  const home = homedir();
  const homes = [
    process.env["CODEX_HOME"],
    join(home, ".config", "codex"),
    join(home, ".codex"),
    ...siblingDirs(home, ".codex-")
  ];
  const found = [];
  for (const dir of new Set(homes.filter((d) => Boolean(d)))) {
    const signIn = codexSignIn(readText(join(dir, "auth.json")));
    if (signIn)
      found.push({ ...signIn, source: dir });
  }
  if (found.length > 0)
    return unlockedSignIns(found);
  return unlockedSignIns(keychainFound(await fromKeychain("Codex Auth", [undefined], codexSignIn), "keychain"));
}
function antigravitySignIn(value) {
  if (value === null)
    return null;
  const encoded = value.startsWith("go-keyring-base64:") ? Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8") : value;
  const root = record(parseJson(encoded));
  const token = record(root["token"]);
  const access = text(token["access_token"]);
  if (!access)
    return null;
  const idToken = text(root["id_token"]);
  const claims = idToken ? jwtClaims(idToken) : {};
  const email = text(claims["email"]);
  const sub = text(claims["sub"]);
  const account = sub || email ? { id: sub ?? email, label: email } : null;
  return { token: access, expiresAt: epochMs(token["expiry"]), account };
}
async function getAntigravitySignIns() {
  const home = homedir();
  const dir = process.env["ANTIGRAVITY_APP_DATA_DIR"] || join(home, ".gemini", "antigravity-cli");
  const file = antigravitySignIn(readText(join(dir, "antigravity-oauth-token")));
  const keychain = await fromKeychain("gemini", ["antigravity"], antigravitySignIn);
  return unlockedSignIns(keychainOrFile(keychain, file, "keychain"));
}
function cursorDatabase(home) {
  return process.platform === "darwin" ? join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb") : join(process.env["XDG_CONFIG_HOME"] || join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}
function cursorAccount(token, email) {
  const id = text(jwtClaims(token)["sub"]);
  return id ? { id, label: email } : null;
}
function cursorAppSignIn(path) {
  if (!existsSync(path))
    return null;
  let db;
  try {
    db = new Database(path, { readonly: true });
    const value = (key) => text(db.query("SELECT value FROM ItemTable WHERE key = ? AND length(value) <= ?").get(key, MAX_READ_BYTES)?.value);
    const token = value("cursorAuth/accessToken");
    return token ? {
      token,
      expiresAt: jwtExpiry(token),
      plan: value("cursorAuth/stripeMembershipType"),
      account: cursorAccount(token, value("cursorAuth/cachedEmail"))
    } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
async function fetchCursorProviders() {
  const home = homedir();
  const app = cursorAppSignIn(cursorDatabase(home));
  const cliEmail = text(record(record(parseJson(readText(join(home, ".cursor", "cli-config.json"))))["authInfo"])["email"]);
  const cli = await fromKeychain("cursor-access-token", [undefined], (value) => {
    const token = text(value);
    return token ? { token, expiresAt: jwtExpiry(token), account: cursorAccount(token, cliEmail) } : null;
  });
  let found;
  if (!app)
    found = keychainFound(cli, "cli");
  else if (!cli || cli === "locked")
    found = [{ ...app, source: "app" }];
  else if (app.account?.id !== cli.account?.id)
    found = [{ ...app, source: "app" }, { ...cli, source: "cli" }];
  else {
    found = (cli.expiresAt ?? 0) > (app.expiresAt ?? 0) ? [{ ...cli, plan: app.plan ?? null, account: app.account, source: "cli" }] : [{ ...app, source: "app" }];
  }
  const results = [];
  for (const item of unlockedSignIns(found)) {
    if (item.expiresAt !== null && item.expiresAt <= Date.now()) {
      results.push({
        id: "cursor",
        account: item.account?.label ?? "",
        plan: item.plan ?? null,
        windows: [],
        problem: "expired"
      });
      continue;
    }
    try {
      const res = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${item.token}`,
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "user-agent": USER_AGENT
        },
        body: "{}",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      if (res.status === 401 || res.status === 403) {
        results.push({ id: "cursor", account: item.account?.label ?? "", plan: item.plan ?? null, windows: [], problem: "expired" });
        continue;
      }
      if (!res.ok)
        continue;
      const body = record(await res.json());
      const plan = record(body["planUsage"]);
      const limit = number(plan["limit"]);
      const remaining = number(plan["remaining"]);
      const used = number(plan["totalPercentUsed"]) ?? (limit && remaining !== null ? (limit - remaining) / limit * 100 : null);
      const resetsAt = isoTime(body["billingCycleEnd"]);
      const windows = [
        [used, null],
        [number(plan["autoPercentUsed"]), "Cursor models"],
        [number(plan["apiPercentUsed"]), "Other models"]
      ].filter((entry) => entry[0] !== null).map(([share, scope]) => ({ kind: "month", scope, used_percent: percent(share), resets_at: resetsAt }));
      const onDemandLimit = number(plan["onDemandLimit"]);
      const onDemandUsed = number(plan["onDemandUsed"]);
      const bonusCredits = number(body["bonusCredits"]) ?? number(body["credits"]);
      let credits = null;
      if (onDemandLimit !== null && onDemandLimit > 0) {
        const usedPct = onDemandUsed !== null ? percent(onDemandUsed / onDemandLimit * 100) : null;
        credits = {
          label: "Extra usage",
          balance: onDemandUsed !== null ? `$${(onDemandUsed / 100).toFixed(2)} / $${(onDemandLimit / 100).toFixed(2)}` : `$${(onDemandLimit / 100).toFixed(2)}`,
          used_percent: usedPct
        };
      } else if (bonusCredits !== null && bonusCredits > 0) {
        credits = { label: "Credits", balance: `${bonusCredits} credits`, used_percent: null };
      }
      results.push({
        id: "cursor",
        account: item.account?.label ?? "",
        plan: item.plan ?? null,
        windows,
        credits,
        problem: null
      });
    } catch {}
  }
  return results;
}
function copilotFileTokens(source) {
  return Object.entries(record(parseJson(source))).flatMap(([host, entry]) => {
    const token = host.startsWith("github.com") ? text(record(entry)["oauth_token"]) : null;
    return token ? [{ token, login: text(record(entry)["user"]), editor: true }] : [];
  });
}
async function ghTokens() {
  const rawStatus = await runCommand(["gh", "auth", "status", "--hostname", "github.com", "--json", "hosts"], 2500);
  const accounts = record(record(parseJson(rawStatus))["hosts"])["github.com"];
  if (!Array.isArray(accounts)) {
    const token = text(await runCommand(["gh", "auth", "token", "--hostname", "github.com"], 2000));
    return token ? [{ token, login: null, editor: false }] : [];
  }
  const tokens = await Promise.all(accounts.map(async (entry) => {
    const account = record(entry);
    const login = text(account["login"]);
    if (!login || account["state"] !== "success")
      return null;
    const fromEnv = ["GH_TOKEN", "GITHUB_TOKEN"].includes(text(account["tokenSource"]) ?? "");
    const token = text(await runCommand(["gh", "auth", "token", "--hostname", "github.com", ...fromEnv ? [] : ["--user", login]], 2000));
    return token ? { token, login, editor: false } : null;
  }));
  return tokens.filter((t) => t !== null);
}
function copilotWindow(value, scope, resetsAt) {
  const quota = record(value);
  const entitlement = number(quota["entitlement"]);
  const left = number(quota["percent_remaining"]);
  if (quota["unlimited"] === true || entitlement === null || entitlement <= 0 || left === null)
    return null;
  return { kind: "month", scope, used_percent: percent(100 - left), resets_at: resetsAt };
}
async function fetchCopilotProviders() {
  const home = homedir();
  const dir = join(process.env["XDG_CONFIG_HOME"] || join(home, ".config"), "github-copilot");
  const tokens = [
    ...copilotFileTokens(readText(join(dir, "apps.json"))),
    ...copilotFileTokens(readText(join(dir, "hosts.json"))),
    ...await ghTokens()
  ];
  if (tokens.length === 0)
    return [];
  const editorAccounts = tokens.flatMap(({ login, editor }) => editor && login ? [login.toLowerCase()] : []);
  const accounts = new Map;
  const seen = new Set;
  let unknown = 0;
  for (const { token, login, editor } of tokens) {
    if (seen.has(token))
      continue;
    seen.add(token);
    const id = login?.toLowerCase() ?? `#${++unknown}`;
    const acc = accounts.get(id) ?? { login, tokens: [], editor: false };
    acc.tokens.push(token);
    acc.editor ||= editor;
    accounts.set(id, acc);
  }
  const results = [];
  for (const [, { login, tokens: accountTokens, editor }] of accounts) {
    let body = null;
    let expired = false;
    for (const token of accountTokens) {
      try {
        const res = await fetch("https://api.github.com/copilot_internal/user", {
          headers: {
            authorization: `token ${token}`,
            accept: "application/json",
            "user-agent": "GitHubCopilotChat/0.26.7",
            "editor-version": "vscode/1.96.2",
            "editor-plugin-version": "copilot-chat/0.26.7",
            "x-github-api-version": "2025-04-01"
          },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
        });
        if (res.status === 404)
          continue;
        if (res.status === 401 || res.status === 403) {
          expired = true;
          continue;
        }
        if (!res.ok)
          break;
        body = record(await res.json());
        break;
      } catch {}
    }
    if (!body) {
      if (expired && editor) {
        results.push({ id: "copilot", account: login ?? "", plan: null, windows: [], problem: "expired" });
      }
      continue;
    }
    const resetsAt = isoTime(body["quota_reset_date"]);
    const snapshots = record(body["quota_snapshots"]);
    const windows = [
      copilotWindow(snapshots["premium_interactions"], "Premium", resetsAt),
      copilotWindow(snapshots["chat"], "Chat", resetsAt),
      copilotWindow(snapshots["completions"], "Completions", resetsAt)
    ].filter((w) => w !== null);
    const left = record(body["limited_user_quotas"]);
    const monthly = record(body["monthly_quotas"]);
    for (const [key, scope] of [
      ["chat", "Chat"],
      ["completions", "Completions"]
    ]) {
      const total = number(monthly[key]);
      const remaining = number(left[key]);
      if (total && total > 0 && remaining !== null && !windows.some((w) => w.scope === scope)) {
        windows.push({
          kind: "month",
          scope,
          used_percent: percent((total - remaining) / total * 100),
          resets_at: isoTime(body["limited_user_reset_date"]) ?? resetsAt
        });
      }
    }
    const plan = text(body["access_type_sku"])?.includes("free") ? "free" : text(body["copilot_plan"]);
    const resolvedLogin = text(body["login"]) ?? login;
    const isEditorAccount = resolvedLogin !== null && editorAccounts.includes(resolvedLogin.toLowerCase());
    if (plan === "free" && !editor && !isEditorAccount)
      continue;
    results.push({
      id: "copilot",
      account: resolvedLogin ?? "",
      plan,
      windows,
      problem: null
    });
  }
  return results;
}
var GROK_PERIOD_KINDS = {
  USAGE_PERIOD_TYPE_DAILY: "day",
  USAGE_PERIOD_TYPE_WEEKLY: "week",
  USAGE_PERIOD_TYPE_MONTHLY: "month"
};
async function fetchGrokProviders() {
  const home = homedir();
  const entries = Object.entries(record(parseJson(readText(join(home, ".grok", "auth.json")))));
  if (entries.length === 0)
    return [];
  const results = [];
  for (const [, raw] of entries) {
    const val = record(raw);
    const token = text(val["key"]);
    if (!token)
      continue;
    const email = text(val["email"]) ?? "";
    const exp = epochMs(val["expires_at"] ?? val["expires"]);
    if (exp !== null && exp <= Date.now()) {
      results.push({ id: "grok", account: email, plan: null, windows: [], problem: "expired" });
      continue;
    }
    try {
      const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
        headers: {
          authorization: `Bearer ${token}`,
          "x-xai-token-auth": "xai-grok-cli",
          accept: "application/json",
          "user-agent": USER_AGENT
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      if (res.status === 401 || res.status === 403) {
        results.push({ id: "grok", account: email, plan: null, windows: [], problem: "expired" });
        continue;
      }
      if (!res.ok)
        continue;
      const body = record(await res.json());
      const config = record(body["config"]);
      const period = record(config["currentPeriod"]);
      const stated = number(config["creditUsagePercent"]);
      const knownKind = GROK_PERIOD_KINDS[text(period["type"]) ?? ""];
      if (stated === null && knownKind === undefined)
        continue;
      const start = epochMs(period["start"]);
      const end = epochMs(period["end"]);
      const kind = knownKind ?? kindOf(start !== null && end !== null ? (end - start) / 1000 : null, "month");
      results.push({
        id: "grok",
        account: email,
        plan: null,
        windows: [{ kind, scope: null, used_percent: percent(stated ?? 0), resets_at: isoTime(period["end"]) }],
        problem: null
      });
    } catch {}
  }
  return results;
}
async function fetchOpencodeProviders() {
  const home = homedir();
  const dir = join(process.env["XDG_DATA_HOME"] || join(home, ".local", "share"), "opencode");
  const root = record(parseJson(readText(join(dir, "auth.json"))));
  let token = null;
  for (const provider of ["opencode-go", "opencode"]) {
    const entry = record(root[provider]);
    if (entry["type"] === "api") {
      token = text(entry["key"]);
      if (token)
        break;
    }
  }
  if (!token)
    token = text(process.env["OPENCODE_API_KEY"]);
  if (!token)
    return [];
  try {
    const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    if (res.status === 403 || !res.ok)
      return [];
    const body = record(await res.json());
    const usage = record(body["usage"]);
    const windows = [];
    for (const [key, kind] of [
      ["rolling", "session"],
      ["weekly", "week"],
      ["monthly", "month"]
    ]) {
      const w = record(usage[key]);
      const p = number(w["percent"]);
      if (p !== null) {
        windows.push({ kind, scope: null, used_percent: percent(p), resets_at: isoTime(w["resetsAt"]) });
      }
    }
    return [{ id: "opencode", account: "", plan: text(body["plan"]) ?? "Go", windows, problem: null }];
  } catch {
    return [];
  }
}
async function fetchOtherProviders() {
  const [cursor, copilot, grok, opencode] = await Promise.all([
    fetchCursorProviders(),
    fetchCopilotProviders(),
    fetchGrokProviders(),
    fetchOpencodeProviders()
  ]);
  return [...cursor, ...copilot, ...grok, ...opencode];
}

// fetcher.ts
var CACHE_DIR = process.env["HERDR_USAGE_CACHE_DIR"] ?? (process.env["XDG_CACHE_HOME"] ? join2(process.env["XDG_CACHE_HOME"], "herdr-usage-monitor") : join2(homedir2(), ".cache", "herdr-usage-monitor"));
var CACHE_FILE = join2(CACHE_DIR, "herdr-usage-cache.json");
var LEGACY_PARTIAL_CACHE_FILE = join2(CACHE_DIR, "herdr-usage-fast-cache.json");
var AGY_CACHE_FILE = join2(CACHE_DIR, "herdr-agy-usage.json");
var RATE_LIMITS_FILE = join2(CACHE_DIR, "rate-limits.json");
async function getRateLimitsAsync() {
  try {
    const file = Bun.file(RATE_LIMITS_FILE);
    if (await file.exists()) {
      return JSON.parse(await file.text());
    }
  } catch {}
  return {};
}
function saveRateLimits(state) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync2(RATE_LIMITS_FILE, JSON.stringify(state));
  } catch {}
}
async function readCacheFile(path, maxAgeMs) {
  try {
    let file = Bun.file(path);
    if (!await file.exists()) {
      const legacyPath = join2("/tmp", basename(path));
      const legacyFile = Bun.file(legacyPath);
      if (await legacyFile.exists()) {
        file = legacyFile;
      }
    }
    if (await file.exists()) {
      const data = JSON.parse(await file.text());
      if (Date.now() - (data.timestamp || 0) < maxAgeMs) {
        return data;
      }
    }
  } catch {}
  return null;
}
async function getCachedReport(maxAgeMs = 300000, options) {
  const complete = await readCacheFile(CACHE_FILE, maxAgeMs);
  if (!options?.allowPartial) {
    return complete && !complete.partial ? complete : null;
  }
  const partial = await readCacheFile(LEGACY_PARTIAL_CACHE_FILE, maxAgeMs);
  if (complete && partial) {
    return complete.timestamp >= partial.timestamp ? complete : partial;
  }
  return complete ?? partial;
}
function saveCachedReport(report) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync2(CACHE_FILE, JSON.stringify(report));
  } catch {}
}
async function fetchDetailedReport() {
  const report = {
    timestamp: Date.now(),
    others: []
  };
  const readAt = {};
  const claudePromise = (async () => {
    const limits = await getRateLimitsAsync();
    if (limits.claudeUntil && Date.now() < limits.claudeUntil) {
      return;
    }
    const claudeSignIns = await getClaudeSignIns().catch(() => []);
    const s = claudeSignIns[0];
    if (!s)
      return;
    const res = await fetch("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", {
      headers: {
        authorization: `Bearer ${s.token}`,
        accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.1.0 (external, cli)"
      },
      signal: AbortSignal.timeout(3500)
    }).catch(() => null);
    if (!res)
      return;
    if (res.status === 429) {
      const retryHeader = res.headers.get("retry-after");
      const retrySec = retryHeader ? parseInt(retryHeader, 10) : NaN;
      const cooldownMs = Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : 300000;
      saveRateLimits({ ...limits, claudeUntil: Date.now() + cooldownMs });
      return;
    }
    if (!res.ok)
      return;
    if (limits.claudeUntil) {
      delete limits.claudeUntil;
      saveRateLimits(limits);
    }
    const body = await res.json();
    const windows = [];
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
      const currency = body.extra_usage?.currency ?? body.spend?.used?.currency ?? "USD";
      const curr = currency === "GBP" ? "\xA3" : currency === "EUR" ? "\u20AC" : currency === "USD" ? "$" : `${currency} `;
      const decimals = body.extra_usage?.decimal_places ?? 2;
      const divisor = Math.pow(10, decimals);
      const usedMinor = body.spend?.used?.amount_minor ?? body.extra_usage?.used_credits ?? 0;
      const limitMinor = body.spend?.limit?.amount_minor ?? body.extra_usage?.monthly_limit ?? 0;
      const usedStr = `${curr}${(usedMinor / divisor).toFixed(decimals)}`;
      const limitStr = `${curr}${(limitMinor / divisor).toFixed(decimals)}`;
      const leftStr = `${curr}${Math.max(0, (limitMinor - usedMinor) / divisor).toFixed(decimals)}`;
      const usedPct = body.extra_usage?.utilization ?? body.spend?.percent ?? 0;
      extra_usage = {
        used: usedStr,
        limit: limitStr,
        balance_left: leftStr,
        used_percent: usedPct
      };
    }
    readAt.claude = Date.now();
    report.claude = {
      account: s.account?.label ?? "default",
      plan: s.plan ?? "pro",
      windows,
      extra_usage
    };
  })().catch(() => {});
  const codexPromise = (async () => {
    const codexSignIns = await getCodexSignIns().catch(() => []);
    const s = codexSignIns[0];
    if (!s)
      return;
    const headers = {
      authorization: `Bearer ${s.token}`,
      accept: "application/json",
      ...s.chatgptAccount ? { "chatgpt-account-id": s.chatgptAccount } : {}
    };
    const [usageRes, creditsRes] = await Promise.all([
      fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers,
        signal: AbortSignal.timeout(3500)
      }),
      fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
        headers,
        signal: AbortSignal.timeout(3500)
      }).catch(() => null)
    ]);
    if (!usageRes.ok)
      return;
    const body = await usageRes.json();
    const creditsBody = creditsRes && creditsRes.ok ? await creditsRes.json() : null;
    const rate = body.rate_limit ?? {};
    const windows = [];
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
    const items = rawCredits.filter((c) => c.status === "available").map((c) => ({
      id: c.id,
      title: c.title ?? "Rate limit reset",
      status: c.status,
      granted_at: c.granted_at,
      expires_at: c.expires_at,
      description: c.description
    })).sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
    readAt.codex = Date.now();
    report.codex = {
      account: s.account?.label ?? body.email ?? "default",
      plan: s.plan ?? body.plan_type ?? "plus",
      windows,
      resets: {
        available: availableResets,
        items
      }
    };
  })().catch(() => {});
  const agyPromise = (async () => {
    let agyData = null;
    let agyReadAt = Date.now();
    try {
      let agyPath = AGY_CACHE_FILE;
      if (!existsSync2(agyPath) && existsSync2("/tmp/herdr-agy-usage.json")) {
        agyPath = "/tmp/herdr-agy-usage.json";
      }
      if (existsSync2(agyPath)) {
        const stat = await Bun.file(agyPath).stat();
        if (Date.now() - stat.mtimeMs < 120000) {
          agyData = JSON.parse(await Bun.file(agyPath).text());
          agyReadAt = stat.mtimeMs;
        }
      }
    } catch {}
    const agySignIns = await getAntigravitySignIns().catch(() => []);
    const s = agySignIns[0];
    const account = s?.account?.label ?? "default";
    if (!agyData) {
      const agyBin = resolveBinary("agy");
      if (agyBin) {
        try {
          const child = Bun.spawn([agyBin, "-p", "/usage", "--output-format", "json"], {
            stdout: "pipe",
            stderr: "ignore"
          });
          const timer = setTimeout(() => {
            try {
              child.kill();
            } catch {}
          }, 4500);
          const text = await new Response(child.stdout).text();
          clearTimeout(timer);
          if (await child.exited === 0 && text) {
            const parsed = JSON.parse(text);
            if (parsed.command?.data?.groups) {
              agyData = parsed.command.data;
              try {
                mkdirSync(CACHE_DIR, { recursive: true });
                writeFileSync2(AGY_CACHE_FILE, JSON.stringify(agyData));
              } catch {}
            }
          }
        } catch {}
      }
    }
    if (agyData?.groups) {
      const groups = agyData.groups.map((g) => {
        const models = g.description?.startsWith("Models within this group:") ? g.description.replace(/^Models within this group:\s*/i, "") : undefined;
        const buckets = (g.buckets ?? []).map((b) => {
          const remFraction = b.remaining_fraction ?? b.remainingFraction ?? 0;
          return {
            label: b.name ?? (b.window === "5h" ? "5h limit" : b.window === "weekly" ? "Weekly limit" : "Limit"),
            remaining_percent: Math.round(remFraction * 100),
            resets_at: b.reset_time ?? b.resetTime ?? null,
            description: b.description
          };
        });
        return {
          name: g.name,
          models,
          buckets
        };
      });
      readAt.antigravity = agyReadAt;
      report.antigravity = {
        account,
        groups
      };
      return;
    }
    if (!s)
      return;
    const headers = {
      authorization: `Bearer ${s.token}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "antigravity"
    };
    let res = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(3000)
    }).catch(() => null);
    if (!res || !res.ok) {
      res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(3000)
      }).catch(() => null);
    }
    if (!res || !res.ok)
      return;
    const body = await res.json();
    const rawGroups = body.groups ?? body.response?.groups;
    const groupsRaw = Array.isArray(rawGroups) ? rawGroups : [];
    const groups = groupsRaw.map((g) => ({
      name: g.displayName ?? g.name ?? "Model group",
      models: g.description?.replace(/^Models within this group:\s*/i, "") ?? "",
      buckets: (g.buckets ?? []).map((b) => {
        const bucketId = String(b.bucketId ?? "");
        const is5h = b.window === "5h" || bucketId.endsWith("-5h");
        const isWeekly = b.window === "weekly" || bucketId.endsWith("-weekly");
        return {
          label: is5h ? "5h limit" : isWeekly ? "Weekly limit" : b.displayName ?? b.name ?? "Limit",
          remaining_percent: Math.round((b.remainingFraction ?? 0) * 100),
          resets_at: b.resetTime ?? null
        };
      })
    }));
    if (groups.length > 0) {
      readAt.antigravity = Date.now();
      report.antigravity = {
        account,
        groups
      };
    }
  })().catch(() => {});
  const othersPromise = fetchOtherProviders().then((others) => {
    report.others = others;
    const now = Date.now();
    for (const p of others)
      readAt[p.id] = now;
  }).catch(() => {});
  await Promise.allSettled([claudePromise, codexPromise, agyPromise, othersPromise]);
  try {
    const prevComplete = await getCachedReport(24 * 3600000);
    const prevAny = await getCachedReport(24 * 3600000, { allowPartial: true });
    const carry = (id, from) => {
      const t = from?.read_at?.[id];
      if (t)
        readAt[id] = t;
    };
    if (!report.claude) {
      const from = prevAny?.claude ? prevAny : prevComplete;
      report.claude = from?.claude;
      carry("claude", from);
    }
    if (!report.codex) {
      const from = prevComplete?.codex ? prevComplete : prevAny;
      report.codex = from?.codex;
      carry("codex", from);
    }
    if (!report.antigravity) {
      const from = prevComplete?.antigravity ? prevComplete : prevAny;
      report.antigravity = from?.antigravity;
      carry("antigravity", from);
    }
    if (report.others.length === 0) {
      const from = prevComplete?.others?.length ? prevComplete : prevAny?.others?.length ? prevAny : null;
      if (from) {
        report.others = from.others;
        for (const p of from.others)
          carry(p.id, from);
      }
    }
    if (report.codex && report.codex.resets.available > 0 && report.codex.resets.items.length === 0 && prevComplete?.codex?.account === report.codex.account && prevComplete.codex.resets.items.length > 0) {
      const now = Date.now();
      report.codex.resets.items = prevComplete.codex.resets.items.filter((item) => {
        const exp = Date.parse(item.expires_at);
        return !Number.isFinite(exp) || exp > now;
      }).slice(0, report.codex.resets.available);
    }
  } catch {}
  report.read_at = readAt;
  saveCachedReport(report);
  return report;
}

// historical.ts
import { existsSync as existsSync3 } from "fs";

// history-db.ts
import { Database as Database2 } from "bun:sqlite";
import { closeSync as closeSync2, mkdirSync as mkdirSync2, openSync as openSync2 } from "fs";
import { homedir as homedir3 } from "os";
import { dirname, join as join3 } from "path";
var SCHEMA_VERSION = 2;
function historyFile() {
  if (process.env.HERDR_USAGE_HISTORY_FILE)
    return process.env.HERDR_USAGE_HISTORY_FILE;
  const data = process.env.XDG_DATA_HOME || join3(homedir3(), ".local", "share");
  return join3(data, "herdr-usage-monitor", "history.sqlite");
}
function tableColumns(db, table) {
  const rows = db.query(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}
function addColumnIfMissing(db, table, existing, name, definition) {
  if (existing.has(name))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  existing.add(name);
}
function createV2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS allowance_readings (
      provider TEXT NOT NULL,
      read_at NUMERIC NOT NULL,
      samples TEXT NOT NULL,
      PRIMARY KEY (provider, read_at)
    );
    CREATE INDEX IF NOT EXISTS allowance_readings_time ON allowance_readings (read_at);

    CREATE TABLE IF NOT EXISTS model_usage (
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      model TEXT NOT NULL,
      effort TEXT,
      model_provider TEXT,
      session_id TEXT,
      source_kind TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      PRIMARY KEY (provider, event_id)
    );
    CREATE INDEX IF NOT EXISTS model_usage_time ON model_usage (observed_at);
    CREATE INDEX IF NOT EXISTS model_usage_model ON model_usage (provider, model, effort, observed_at);
    CREATE INDEX IF NOT EXISTS model_usage_historical ON model_usage (observed_at, provider, model);

    CREATE TABLE IF NOT EXISTS model_log_offsets (
      log_id TEXT PRIMARY KEY NOT NULL,
      byte_offset INTEGER NOT NULL,
      modified_at REAL NOT NULL,
      file_size INTEGER,
      parser_version INTEGER NOT NULL DEFAULT 2,
      state_json TEXT
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}
function migrateV1ToV2(db) {
  const usageCols = tableColumns(db, "model_usage");
  addColumnIfMissing(db, "model_usage", usageCols, "model_provider", "TEXT");
  addColumnIfMissing(db, "model_usage", usageCols, "session_id", "TEXT");
  addColumnIfMissing(db, "model_usage", usageCols, "source_kind", "TEXT");
  addColumnIfMissing(db, "model_usage", usageCols, "input_tokens", "INTEGER");
  addColumnIfMissing(db, "model_usage", usageCols, "output_tokens", "INTEGER");
  addColumnIfMissing(db, "model_usage", usageCols, "cache_read_tokens", "INTEGER");
  addColumnIfMissing(db, "model_usage", usageCols, "cache_write_tokens", "INTEGER");
  addColumnIfMissing(db, "model_usage", usageCols, "reasoning_tokens", "INTEGER");
  const offsetCols = tableColumns(db, "model_log_offsets");
  addColumnIfMissing(db, "model_log_offsets", offsetCols, "file_size", "INTEGER");
  addColumnIfMissing(db, "model_log_offsets", offsetCols, "parser_version", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "model_log_offsets", offsetCols, "state_json", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS model_usage_historical ON model_usage (observed_at, provider, model);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}
function openHistoryDatabase(file, readonly = false) {
  if (!readonly) {
    mkdirSync2(dirname(file), { recursive: true, mode: 448 });
    closeSync2(openSync2(file, "a", 384));
  }
  const db = new Database2(file, readonly ? { readonly: true } : { readwrite: true });
  try {
    db.run("PRAGMA busy_timeout = 2000");
    if (!readonly) {
      db.run("PRAGMA journal_mode = WAL");
      const version = db.query("PRAGMA user_version").get()?.user_version ?? 0;
      if (version === 0) {
        db.transaction(() => createV2Schema(db)).immediate();
      } else if (version === 1) {
        db.transaction(() => migrateV1ToV2(db)).immediate();
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// historical.ts
var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
var WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var PROVIDER_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi"
};
var TOP_SERIES_LIMIT = 7;
var LEADERBOARD_LIMIT = 10;
var FACET_MODEL_LIMIT = 250;
var round1 = (value) => Math.round(value * 10) / 10;
function providerDisplay(id) {
  return PROVIDER_NAMES[id] ?? id;
}
function cleanFilter(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "all" || trimmed === "*")
    return "all";
  return trimmed;
}
function parseHorizon(value) {
  const v = String(value ?? "").toLowerCase();
  return v === "d" || v === "w" || v === "m" || v === "y" ? v : "m";
}
function formatHourShort(hour) {
  if (hour === 0)
    return "12a";
  if (hour < 12)
    return `${hour}a`;
  if (hour === 12)
    return "12p";
  return `${hour - 12}p`;
}
function formatHourClock(hour) {
  const h = (hour % 24 + 24) % 24;
  return `${h % 12 || 12}:00 ${h < 12 ? "AM" : "PM"}`;
}
function formatShortDate(date, includeYear = false) {
  const base = `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
  return includeYear ? `${base}, ${date.getFullYear()}` : base;
}
function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}
function buildHorizonWindow(horizon, offset, now) {
  const safeOffset = Number.isFinite(offset) ? Math.min(0, Math.trunc(offset)) : 0;
  const current = new Date(now);
  const curY = current.getFullYear();
  const curM = current.getMonth();
  const curD = current.getDate();
  if (horizon === "d") {
    const target = new Date(curY, curM, curD + safeOffset, 0, 0, 0, 0);
    const tY = target.getFullYear();
    const tM = target.getMonth();
    const tD = target.getDate();
    const startMs = target.getTime();
    const endMs = new Date(tY, tM, tD + 1, 0, 0, 0, 0).getTime();
    const prevStart = new Date(tY, tM, tD - 1, 0, 0, 0, 0);
    const prevStartMs = prevStart.getTime();
    const prevEndMs = safeOffset === 0 ? Math.min(startMs, prevStartMs + Math.max(0, now - startMs)) : startMs;
    const dateTag = formatShortDate(target, tY !== curY);
    const label = safeOffset === 0 ? `Today \xB7 ${dateTag}` : safeOffset === -1 ? `Yesterday \xB7 ${dateTag}` : `${WEEKDAYS_SHORT[target.getDay()]}, ${formatShortDate(target, true)}`;
    const buckets = [];
    for (let h = 0;h < 24; h += 1) {
      const bStart = new Date(tY, tM, tD, h, 0, 0, 0).getTime();
      const bEnd = h === 23 ? endMs : new Date(tY, tM, tD, h + 1, 0, 0, 0).getTime();
      buckets.push({
        startMs: bStart,
        endMs: bEnd,
        label: `${dateTag} \xB7 ${formatHourClock(h)}\u2013${formatHourClock(h + 1)}`,
        axisLabel: h % 4 === 0 ? formatHourShort(h) : ""
      });
    }
    return { startMs, endMs, prevStartMs, prevEndMs, label, unitSummary: "24 hours", buckets };
  }
  if (horizon === "w") {
    const dow = (current.getDay() + 6) % 7;
    const monday = new Date(curY, curM, curD - dow + safeOffset * 7, 0, 0, 0, 0);
    const mY = monday.getFullYear();
    const mM = monday.getMonth();
    const mD = monday.getDate();
    const startMs = monday.getTime();
    const endMs = new Date(mY, mM, mD + 7, 0, 0, 0, 0).getTime();
    const sunday = new Date(mY, mM, mD + 6, 0, 0, 0, 0);
    const prevStartMs = new Date(mY, mM, mD - 7, 0, 0, 0, 0).getTime();
    const prevEndMs = safeOffset === 0 ? Math.min(startMs, prevStartMs + Math.max(0, now - startMs)) : startMs;
    const crossYear = monday.getFullYear() !== sunday.getFullYear();
    const showYear = monday.getFullYear() !== curY || crossYear;
    const span = `${formatShortDate(monday, crossYear)} \u2013 ${formatShortDate(sunday, showYear)}`;
    const label = safeOffset === 0 ? `This week \xB7 ${span}` : span;
    const buckets = [];
    for (let i = 0;i < 7; i += 1) {
      const day = new Date(mY, mM, mD + i, 0, 0, 0, 0);
      const bStart = day.getTime();
      const bEnd = new Date(mY, mM, mD + i + 1, 0, 0, 0, 0).getTime();
      buckets.push({
        startMs: bStart,
        endMs: bEnd,
        label: `${WEEKDAYS_SHORT[day.getDay()]}, ${formatShortDate(day, day.getFullYear() !== curY)}`,
        axisLabel: `${WEEKDAYS_SHORT[day.getDay()]} ${day.getDate()}`
      });
    }
    return { startMs, endMs, prevStartMs, prevEndMs, label, unitSummary: "7 days", buckets };
  }
  if (horizon === "m") {
    const first = new Date(curY, curM + safeOffset, 1, 0, 0, 0, 0);
    const fY = first.getFullYear();
    const fM = first.getMonth();
    const count = daysInMonth(fY, fM);
    const startMs = first.getTime();
    const endMs = new Date(fY, fM + 1, 1, 0, 0, 0, 0).getTime();
    const prevFirst = new Date(fY, fM - 1, 1, 0, 0, 0, 0);
    const prevStartMs = prevFirst.getTime();
    let prevEndMs = startMs;
    if (safeOffset === 0) {
      const prevDays = daysInMonth(prevFirst.getFullYear(), prevFirst.getMonth());
      const clampedDay = Math.min(curD, prevDays);
      const prevSameMoment = new Date(prevFirst.getFullYear(), prevFirst.getMonth(), clampedDay, current.getHours(), current.getMinutes(), current.getSeconds(), current.getMilliseconds()).getTime();
      prevEndMs = Math.min(startMs, prevSameMoment);
    }
    const label = `${MONTHS_LONG[fM]} ${fY}`;
    const buckets = [];
    for (let d = 1;d <= count; d += 1) {
      const day = new Date(fY, fM, d, 0, 0, 0, 0);
      const bStart = day.getTime();
      const bEnd = new Date(fY, fM, d + 1, 0, 0, 0, 0).getTime();
      const showTick = d === 1 || d % 5 === 1 && count - d >= 2;
      buckets.push({
        startMs: bStart,
        endMs: bEnd,
        label: `${WEEKDAYS_SHORT[day.getDay()]}, ${formatShortDate(day, fY !== curY)}`,
        axisLabel: showTick ? `${MONTHS_SHORT[fM]} ${d}` : ""
      });
    }
    return { startMs, endMs, prevStartMs, prevEndMs, label, unitSummary: `${count} days`, buckets };
  }
  const targetYear = curY + safeOffset;
  const startMs = new Date(targetYear, 0, 1, 0, 0, 0, 0).getTime();
  const endMs = new Date(targetYear + 1, 0, 1, 0, 0, 0, 0).getTime();
  const prevStartMs = new Date(targetYear - 1, 0, 1, 0, 0, 0, 0).getTime();
  let prevEndMs = startMs;
  if (safeOffset === 0) {
    const clampedDay = Math.min(curD, daysInMonth(targetYear - 1, curM));
    const prevSameMoment = new Date(targetYear - 1, curM, clampedDay, current.getHours(), current.getMinutes(), current.getSeconds(), current.getMilliseconds()).getTime();
    prevEndMs = Math.min(startMs, prevSameMoment);
  }
  const buckets = [];
  let lastLabeledMonth = -1;
  for (let w = 0;w < 52; w += 1) {
    const bStartDate = new Date(targetYear, 0, 1 + w * 7, 0, 0, 0, 0);
    const bEndDate = w === 51 ? new Date(targetYear + 1, 0, 1, 0, 0, 0, 0) : new Date(targetYear, 0, 1 + (w + 1) * 7, 0, 0, 0, 0);
    const lastDay = new Date(bEndDate.getTime() - 1);
    const month = bStartDate.getMonth();
    const axisLabel = month !== lastLabeledMonth ? MONTHS_SHORT[month] : "";
    lastLabeledMonth = month;
    buckets.push({
      startMs: bStartDate.getTime(),
      endMs: bEndDate.getTime(),
      label: `${formatShortDate(bStartDate)} \u2013 ${formatShortDate(lastDay, true)}`,
      axisLabel
    });
  }
  return {
    startMs,
    endMs,
    prevStartMs,
    prevEndMs,
    label: String(targetYear),
    unitSummary: "52 weeks",
    buckets
  };
}
function compareChange(current, previous) {
  if (previous === null)
    return { deltaPct: null, deltaKind: "none" };
  if (previous === 0) {
    if (current === 0)
      return { deltaPct: 0, deltaKind: "flat" };
    return { deltaPct: null, deltaKind: "new" };
  }
  const pct = round1((current - previous) / previous * 100);
  if (pct === 0)
    return { deltaPct: 0, deltaKind: "flat" };
  return { deltaPct: pct, deltaKind: pct > 0 ? "up" : "down" };
}
function tokenSum(row, includeCache) {
  return row.input_tokens + row.output_tokens + (includeCache ? row.cache_read_tokens + row.cache_write_tokens : 0);
}
function bucketIndexFor(buckets, timestamp) {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const b = buckets[mid];
    if (timestamp < b.startMs)
      hi = mid - 1;
    else if (timestamp >= b.endMs)
      lo = mid + 1;
    else
      return mid;
  }
  return -1;
}
function emptyPayload(horizon, offset, includeCache, filters, win, now, backfill = { pendingFiles: 0, totalFiles: 0 }) {
  return {
    version: 1,
    horizon,
    offset,
    includeCache,
    filters,
    latestActivityMs: null,
    range: {
      startMs: win.startMs,
      endMs: win.endMs,
      elapsedEndMs: Math.min(now, win.endMs),
      label: win.label,
      subtitle: `${win.unitSummary} \xB7 ${includeCache ? "cache included" : "cache excluded"}`,
      hasNext: offset < 0
    },
    summary: {
      totalTokens: 0,
      prevTotalTokens: null,
      deltaPct: null,
      deltaKind: "none",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      cacheHitRate: null,
      sessions: 0,
      events: 0,
      unmeasuredEvents: 0,
      topModel: null,
      peakBucket: null
    },
    series: {
      models: [],
      maxBucketTotal: 0,
      maxModelBucket: 0,
      maxCumulativeTotal: 0,
      maxModelCumulative: 0,
      buckets: win.buckets.map((spec) => ({
        startMs: spec.startMs,
        endMs: spec.endMs,
        label: spec.label,
        axisLabel: spec.axisLabel,
        future: spec.startMs > now,
        total: 0,
        cumulativeTotal: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        events: 0,
        byModel: {},
        cumulativeByModel: {}
      }))
    },
    leaderboard: { totalModels: 0, entries: [] },
    facets: { providers: [], models: [] },
    backfill
  };
}
function readHistorical(options = {}, file = historyFile(), backfill = { pendingFiles: 0, totalFiles: 0 }) {
  const now = options.now ?? Date.now();
  const horizon = parseHorizon(options.horizon);
  const offset = Number.isFinite(options.offset) ? Math.min(0, Math.trunc(options.offset)) : 0;
  const includeCache = options.includeCache !== false;
  const providerFilter = cleanFilter(options.provider);
  const modelFilter = cleanFilter(options.model);
  const filters = { provider: providerFilter, model: modelFilter };
  const win = buildHorizonWindow(horizon, offset, now);
  if (!existsSync3(file)) {
    return emptyPayload(horizon, offset, includeCache, filters, win, now, backfill);
  }
  const db = openHistoryDatabase(file, true);
  try {
    if (!db.query("SELECT 1 FROM sqlite_schema WHERE name = 'model_usage'").get()) {
      return emptyPayload(horizon, offset, includeCache, filters, win, now, backfill);
    }
    const cols = new Set(db.query("PRAGMA table_info(model_usage)").all().map((c) => c.name));
    if (!cols.has("input_tokens")) {
      const legacyCount = db.query("SELECT COUNT(*) AS c FROM model_usage WHERE observed_at >= ? AND observed_at < ?").get(win.startMs, win.endMs)?.c ?? 0;
      const result = emptyPayload(horizon, offset, includeCache, filters, win, now, backfill);
      result.summary.unmeasuredEvents = legacyCount;
      return result;
    }
    const whereParts = ["observed_at >= ?", "observed_at < ?"];
    const params = [win.startMs, win.endMs];
    if (providerFilter !== "all") {
      whereParts.push("provider = ?");
      params.push(providerFilter);
    }
    if (modelFilter !== "all") {
      whereParts.push("model = ?");
      params.push(modelFilter);
    }
    const rows = db.query(`
      SELECT provider, observed_at, model, effort, session_id, source_kind,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
      FROM model_usage
      WHERE ${whereParts.join(" AND ")}
      ORDER BY observed_at
    `).all(...params);
    const prevWhereParts = ["observed_at >= ?", "observed_at < ?", "input_tokens IS NOT NULL"];
    const prevParams = [win.prevStartMs, win.prevEndMs];
    if (providerFilter !== "all") {
      prevWhereParts.push("provider = ?");
      prevParams.push(providerFilter);
    }
    if (modelFilter !== "all") {
      prevWhereParts.push("model = ?");
      prevParams.push(modelFilter);
    }
    const prevRows = db.query(`
      SELECT model,
             SUM(COALESCE(input_tokens, 0)) AS input_tokens,
             SUM(COALESCE(output_tokens, 0)) AS output_tokens,
             SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
             SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens
      FROM model_usage
      WHERE ${prevWhereParts.join(" AND ")}
      GROUP BY model
    `).all(...prevParams);
    const prevByModel = new Map;
    let prevTotalTokens = 0;
    for (const row of prevRows) {
      const sum = tokenSum(row, includeCache);
      prevByModel.set(row.model, sum);
      prevTotalTokens += sum;
    }
    const earliestMeasured = db.query("SELECT MIN(observed_at) AS earliest, MAX(observed_at) AS latest FROM model_usage WHERE input_tokens IS NOT NULL").get();
    const hasPrevHistory = earliestMeasured?.earliest != null && earliestMeasured.earliest < win.prevEndMs;
    const latestActivityMs = earliestMeasured?.latest ?? null;
    const allKnownProviders = db.query("SELECT DISTINCT provider FROM model_usage WHERE input_tokens IS NOT NULL ORDER BY provider").all().map((r) => r.provider);
    const windowFacetRows = db.query(`
      SELECT provider, model,
             SUM(COALESCE(input_tokens, 0)) AS input_tokens,
             SUM(COALESCE(output_tokens, 0)) AS output_tokens,
             SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
             SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
             COUNT(DISTINCT session_id) AS sessions
      FROM model_usage
      WHERE observed_at >= ? AND observed_at < ? AND input_tokens IS NOT NULL
      GROUP BY provider, model
    `).all(win.startMs, win.endMs);
    const providerFacetMap = new Map;
    for (const p of allKnownProviders)
      providerFacetMap.set(p, { tokens: 0, sessions: 0 });
    const modelFacetMap = new Map;
    for (const r of windowFacetRows) {
      const tokens = tokenSum(r, includeCache);
      if (modelFilter === "all" || r.model === modelFilter) {
        const entry = providerFacetMap.get(r.provider) ?? { tokens: 0, sessions: 0 };
        entry.tokens += tokens;
        entry.sessions += r.sessions;
        providerFacetMap.set(r.provider, entry);
      }
      if (providerFilter === "all" || r.provider === providerFilter) {
        const entry = modelFacetMap.get(r.model) ?? { tokens: 0, sessions: 0 };
        entry.tokens += tokens;
        entry.sessions += r.sessions;
        modelFacetMap.set(r.model, entry);
      }
    }
    if (providerFilter !== "all" && !providerFacetMap.has(providerFilter)) {
      providerFacetMap.set(providerFilter, { tokens: 0, sessions: 0 });
    }
    if (modelFilter !== "all" && !modelFacetMap.has(modelFilter)) {
      modelFacetMap.set(modelFilter, { tokens: 0, sessions: 0 });
    }
    const providerFacets = [...providerFacetMap.entries()].map(([value, stat]) => ({ value, label: providerDisplay(value), tokens: stat.tokens, sessions: stat.sessions })).sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
    const allModelFacets = [...modelFacetMap.entries()].map(([value, stat]) => ({ value, tokens: stat.tokens, sessions: stat.sessions })).sort((a, b) => b.tokens - a.tokens || a.value.localeCompare(b.value));
    const modelFacets = allModelFacets.slice(0, FACET_MODEL_LIMIT);
    if (modelFilter !== "all" && !modelFacets.some((m) => m.value === modelFilter)) {
      const selected = allModelFacets.find((m) => m.value === modelFilter);
      if (selected) {
        if (modelFacets.length >= FACET_MODEL_LIMIT)
          modelFacets.pop();
        modelFacets.push(selected);
      }
    }
    const bucketAccum = win.buckets.map((spec) => ({
      spec,
      total: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      events: 0,
      byModel: new Map
    }));
    const modelGroups = new Map;
    const allSessions = new Set;
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let reasoningTokens = 0;
    let events = 0;
    let unmeasuredEvents = 0;
    for (const row of rows) {
      if (row.input_tokens === null) {
        if (row.source_kind === null)
          unmeasuredEvents += 1;
        continue;
      }
      const input = row.input_tokens ?? 0;
      const output = row.output_tokens ?? 0;
      const cacheRead = row.cache_read_tokens ?? 0;
      const cacheWrite = row.cache_write_tokens ?? 0;
      const reasoning = row.reasoning_tokens ?? 0;
      const tokens = input + output + (includeCache ? cacheRead + cacheWrite : 0);
      totalTokens += tokens;
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cacheRead;
      cacheWriteTokens += cacheWrite;
      reasoningTokens += reasoning;
      events += 1;
      if (row.session_id)
        allSessions.add(row.session_id);
      let group = modelGroups.get(row.model);
      if (!group) {
        group = {
          model: row.model,
          tokens: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          events: 0,
          sessions: new Set,
          providers: new Map,
          efforts: new Map
        };
        modelGroups.set(row.model, group);
      }
      group.tokens += tokens;
      group.input += input;
      group.output += output;
      group.cacheRead += cacheRead;
      group.cacheWrite += cacheWrite;
      group.reasoning += reasoning;
      group.events += 1;
      if (row.session_id)
        group.sessions.add(row.session_id);
      group.providers.set(row.provider, (group.providers.get(row.provider) ?? 0) + Math.max(tokens, 1));
      if (row.effort) {
        group.efforts.set(row.effort, (group.efforts.get(row.effort) ?? 0) + Math.max(tokens, 1));
      }
      const idx = bucketIndexFor(win.buckets, row.observed_at);
      if (idx >= 0) {
        const b = bucketAccum[idx];
        b.total += tokens;
        b.input += input;
        b.output += output;
        b.cacheRead += cacheRead;
        b.cacheWrite += cacheWrite;
        b.events += 1;
        if (tokens > 0) {
          b.byModel.set(row.model, (b.byModel.get(row.model) ?? 0) + tokens);
        }
      }
    }
    const sortedGroups = [...modelGroups.values()].sort((a, b) => b.tokens - a.tokens || b.events - a.events || a.model.localeCompare(b.model));
    const topModels = sortedGroups.filter((g) => g.tokens > 0).slice(0, TOP_SERIES_LIMIT).map((g) => g.model);
    const keepSet = new Set(topModels);
    let hasOther = false;
    for (const b of bucketAccum) {
      for (const [m, t] of b.byModel) {
        if (t > 0 && !keepSet.has(m)) {
          hasOther = true;
          break;
        }
      }
      if (hasOther)
        break;
    }
    const seriesModels = hasOther ? [...topModels, "Other"] : topModels;
    let runningTotal = 0;
    const runningByModel = new Map;
    let maxBucketTotal = 0;
    let maxModelBucket = 0;
    let maxCumulativeTotal = 0;
    let maxModelCumulative = 0;
    let peakBucket = null;
    const buckets = bucketAccum.map((b) => {
      const future = b.spec.startMs > now;
      const byModel = {};
      let other = 0;
      for (const name of topModels) {
        const val = b.byModel.get(name) ?? 0;
        if (val > 0) {
          byModel[name] = val;
          if (val > maxModelBucket)
            maxModelBucket = val;
        }
      }
      for (const [name, val] of b.byModel) {
        if (!keepSet.has(name))
          other += val;
      }
      if (other > 0) {
        byModel.Other = other;
        if (other > maxModelBucket)
          maxModelBucket = other;
      }
      if (!future) {
        runningTotal += b.total;
        if (runningTotal > maxCumulativeTotal)
          maxCumulativeTotal = runningTotal;
        for (const name of seriesModels) {
          const next = (runningByModel.get(name) ?? 0) + (byModel[name] ?? 0);
          runningByModel.set(name, next);
          if (next > maxModelCumulative)
            maxModelCumulative = next;
        }
      }
      const cumulativeByModel = {};
      if (!future) {
        for (const name of seriesModels) {
          const val = runningByModel.get(name) ?? 0;
          if (val > 0)
            cumulativeByModel[name] = val;
        }
      }
      if (b.total > maxBucketTotal)
        maxBucketTotal = b.total;
      if (b.total > 0 && (!peakBucket || b.total > peakBucket.tokens)) {
        peakBucket = { label: b.spec.label, tokens: b.total };
      }
      return {
        startMs: b.spec.startMs,
        endMs: b.spec.endMs,
        label: b.spec.label,
        axisLabel: b.spec.axisLabel,
        future,
        total: b.total,
        cumulativeTotal: future ? 0 : runningTotal,
        input: b.input,
        output: b.output,
        cacheRead: b.cacheRead,
        cacheWrite: b.cacheWrite,
        events: b.events,
        byModel,
        cumulativeByModel
      };
    });
    const leaderboardEntries = sortedGroups.slice(0, LEADERBOARD_LIMIT).map((g, i) => {
      const providersSorted = [...g.providers.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const primaryProvider = providersSorted[0]?.[0] ?? "unknown";
      const prevTokens = hasPrevHistory ? prevByModel.get(g.model) ?? 0 : null;
      const change = compareChange(g.tokens, prevTokens);
      const effortSum = [...g.efforts.values()].reduce((acc, v) => acc + v, 0);
      const efforts = effortSum > 0 ? [...g.efforts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([effort, weight]) => ({ effort, sharePct: round1(weight / effortSum * 100) })) : [];
      return {
        rank: i + 1,
        model: g.model,
        provider: primaryProvider,
        providers: providersSorted.map(([p]) => p),
        tokens: g.tokens,
        input: g.input,
        output: g.output,
        cacheRead: g.cacheRead,
        cacheWrite: g.cacheWrite,
        reasoning: g.reasoning,
        sessions: g.sessions.size,
        events: g.events,
        sharePct: totalTokens > 0 ? round1(g.tokens / totalTokens * 100) : 0,
        prevTokens,
        deltaPct: change.deltaPct,
        deltaKind: change.deltaKind,
        efforts
      };
    });
    const summaryPrev = hasPrevHistory ? prevTotalTokens : null;
    const summaryChange = compareChange(totalTokens, summaryPrev);
    const inputSide = inputTokens + cacheReadTokens + cacheWriteTokens;
    const cacheHitRate = inputSide > 0 ? round1(cacheReadTokens / inputSide * 100) : null;
    const topEntry = leaderboardEntries[0] ?? null;
    return {
      version: 1,
      horizon,
      offset,
      includeCache,
      filters,
      latestActivityMs,
      range: {
        startMs: win.startMs,
        endMs: win.endMs,
        elapsedEndMs: Math.min(now, win.endMs),
        label: win.label,
        subtitle: `${win.unitSummary} \xB7 ${includeCache ? "cache included" : "cache excluded"}`,
        hasNext: offset < 0
      },
      summary: {
        totalTokens,
        prevTotalTokens: summaryPrev,
        deltaPct: summaryChange.deltaPct,
        deltaKind: summaryChange.deltaKind,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        cacheHitRate,
        sessions: allSessions.size,
        events,
        unmeasuredEvents,
        topModel: topEntry ? { model: topEntry.model, provider: topEntry.provider, tokens: topEntry.tokens, sharePct: topEntry.sharePct } : null,
        peakBucket
      },
      series: {
        models: seriesModels,
        maxBucketTotal,
        maxModelBucket,
        maxCumulativeTotal,
        maxModelCumulative,
        buckets
      },
      leaderboard: {
        totalModels: sortedGroups.length,
        entries: leaderboardEntries
      },
      facets: {
        providers: providerFacets,
        models: modelFacets
      },
      backfill
    };
  } finally {
    db.close();
  }
}

// history.ts
import { existsSync as existsSync4 } from "fs";
import { createHash as createHash2 } from "crypto";

// herdr-app/mods/usage-monitor/pace.js
var HOUR = 3600000;
var DAY = 24 * HOUR;
var CREDIT_SOON = 3 * DAY;
function windowLength(text) {
  const s = String(text ?? "").toLowerCase();
  if (/\b5\s*h\b|five[\s-]hour/.test(s))
    return 5 * HOUR;
  if (/\b7\s*d\b|week/.test(s))
    return 7 * DAY;
  if (/\b24\s*h\b|\bday\b|daily/.test(s))
    return DAY;
  if (/month/.test(s))
    return 30 * DAY;
  return null;
}

// history.ts
var MINUTE = 60000;
var HOUR2 = 60 * MINUTE;
var DAY2 = 24 * HOUR2;
var WEEK = 7 * DAY2;
var BUCKETS = 180;
var round = (value) => Math.round(value * 10) / 10;
function accountId(account) {
  return account ? createHash2("sha256").update(account).digest("hex").slice(0, 10) : undefined;
}
function accountNames(report) {
  const names = new Map;
  for (const provider of [report?.claude, report?.codex, report?.antigravity, ...report?.others ?? []]) {
    const id = accountId(provider?.account);
    if (id)
      names.set(id, provider.account);
  }
  return names;
}
function labelAccounts(charts, names) {
  const accounts = new Map;
  for (const b of charts) {
    if (!accounts.has(b.provider))
      accounts.set(b.provider, new Set);
    accounts.get(b.provider).add(b.account);
  }
  return charts.map((b) => {
    if ((accounts.get(b.provider)?.size ?? 0) < 2)
      return b;
    return { ...b, accountLabel: b.account && names.get(b.account) || "Another account" };
  });
}
function samplesFrom(report) {
  const samples = [];
  const add = (p, account, sample) => {
    const a = accountId(account);
    samples.push({ p, ...a ? { a } : {}, ...sample });
  };
  for (const [id, provider] of [["claude", report.claude], ["codex", report.codex]]) {
    for (const w of provider?.windows ?? []) {
      add(id, provider.account, { w: w.label, left: round(100 - w.used_percent), reset: w.resets_at ?? null });
    }
  }
  for (const group of report.antigravity?.groups ?? []) {
    for (const b of group.buckets ?? []) {
      add("antigravity", report.antigravity.account, { g: group.name, w: b.label, left: round(b.remaining_percent), reset: b.resets_at ?? null });
    }
  }
  for (const provider of report.others ?? []) {
    for (const w of provider.windows ?? []) {
      add(provider.id, provider.account, {
        ...w.scope ? { g: w.scope } : {},
        w: w.kind,
        left: round(100 - w.used_percent),
        reset: w.resets_at ?? null
      });
    }
  }
  return samples.filter((s) => Number.isFinite(s.left));
}
function recordReport(report, file = historyFile()) {
  const readAt = report.read_at;
  if (!readAt)
    return;
  const providers = new Map;
  for (const sample of samplesFrom(report)) {
    const t = readAt[sample.p];
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0)
      continue;
    const samples = providers.get(sample.p);
    if (samples)
      samples.push(sample);
    else
      providers.set(sample.p, [sample]);
  }
  if (!providers.size)
    return;
  const db = openHistoryDatabase(file);
  try {
    const insert = db.query(`
      INSERT INTO allowance_readings (provider, read_at, samples) VALUES (?, ?, ?)
      ON CONFLICT (provider, read_at) DO NOTHING
    `);
    db.transaction(() => {
      for (const [provider, samples] of providers) {
        insert.run(provider, readAt[provider], JSON.stringify(samples));
      }
    }).immediate();
  } finally {
    db.close();
  }
}
function readHistory(file = historyFile(), since = 0) {
  if (!existsSync4(file))
    return [];
  const db = openHistoryDatabase(file, true);
  try {
    if (!db.query("SELECT 1 FROM sqlite_schema WHERE name = 'allowance_readings'").get())
      return [];
    const rows = db.query("SELECT read_at AS t, samples FROM allowance_readings WHERE read_at >= ? ORDER BY read_at, rowid").all(since);
    const entries = [];
    for (const { t, samples } of rows) {
      const parsed = JSON.parse(samples);
      const last = entries.at(-1);
      if (last?.t === t)
        last.s.push(...parsed);
      else
        entries.push({ t, s: parsed });
    }
    return entries;
  } finally {
    db.close();
  }
}
var windowOf = (s) => s.p === "antigravity" ? windowLength(s.w) ?? s.w : s.w;
var limitOf = (s) => `${s.p}\x00${s.g ?? ""}\x00${windowOf(s)}`;
var ROLLING = MINUTE;
var CHARTED = new Set([5 * HOUR2, WEEK]);
function readBurndowns(file = historyFile(), now = Date.now()) {
  return burndowns(readHistory(file, now - WEEK - DAY2), now);
}
function burndowns(entries, now = Date.now()) {
  const accounts = new Map;
  for (const entry of entries) {
    for (const s of entry.s) {
      if (!s.a)
        continue;
      if (!accounts.has(limitOf(s)))
        accounts.set(limitOf(s), new Set);
      accounts.get(limitOf(s)).add(s.a);
    }
  }
  const accountOf = (s) => {
    if (s.a)
      return s.a;
    const known = accounts.get(limitOf(s));
    return known?.size === 1 ? [...known][0] : "";
  };
  const series = new Map;
  for (const entry of entries) {
    for (const s of entry.s) {
      const key = `${limitOf(s)}\x00${accountOf(s)}`;
      if (!series.has(key))
        series.set(key, []);
      series.get(key).push({ t: entry.t, s });
    }
  }
  const result = [];
  const latestRead = new Map;
  for (const readings of series.values()) {
    const { t, s } = readings.at(-1);
    const key = `${s.p}\x00${accountOf(s)}`;
    latestRead.set(key, Math.max(latestRead.get(key) ?? 0, t));
  }
  for (const readings of series.values()) {
    const latest = readings.at(-1);
    if (now - latest.t > DAY2)
      continue;
    if (latest.t < latestRead.get(`${latest.s.p}\x00${accountOf(latest.s)}`))
      continue;
    const length = windowLength(latest.s.w);
    if (!length || !CHARTED.has(length))
      continue;
    const quoted = Date.parse(latest.s.reset ?? "");
    const rolling = latest.s.left >= 100 && quoted >= latest.t + length - ROLLING;
    const reset = rolling ? NaN : quoted;
    const unstarted = !Number.isFinite(reset) && latest.s.left >= 100;
    const end = Number.isFinite(reset) ? reset : unstarted ? now + length : now;
    const start = end - length;
    const inWindow = unstarted ? [] : readings.filter((r) => r.t >= start && r.t <= end);
    const account = accountOf(latest.s);
    result.push({
      provider: latest.s.p,
      ...account ? { account } : {},
      ...latest.s.g ? { group: latest.s.g } : {},
      label: latest.s.w,
      length,
      start,
      end,
      left: latest.s.left,
      reset: rolling ? null : latest.s.reset,
      runs: unstarted ? [[start, start, latest.s.left]] : runs(inWindow.map((r) => [r.t, r.s.left]), length, Math.min(now, end))
    });
  }
  return result;
}
function runs(readings, length, until) {
  const slice = length / BUCKETS;
  const gap = Math.max(20 * MINUTE, 3 * slice);
  const thinned = [];
  for (const reading of readings) {
    const last = thinned.at(-1);
    if (last && Math.floor(last[0] / slice) === Math.floor(reading[0] / slice))
      thinned[thinned.length - 1] = reading;
    else
      thinned.push(reading);
  }
  const out = [];
  thinned.forEach(([t, left], i) => {
    const next = thinned[i + 1]?.[0] ?? until;
    const to = next - t <= gap ? Math.max(next, t) : t + slice;
    const prev = out.at(-1);
    if (prev && prev[1] === t && prev[2] === left)
      prev[1] = to;
    else
      out.push([t, to, left]);
  });
  return out;
}

// model-usage.ts
import { createHash as createHash3 } from "crypto";
import { existsSync as existsSync5 } from "fs";
import { readdir, stat } from "fs/promises";
import { homedir as homedir4 } from "os";
import { basename as basename2, dirname as dirname2, join as join4, resolve } from "path";
var PARSER_VERSION = 2;
var DEFAULT_SYNC_BUDGET_MS = 3000;
var CODEX_TWIN_WINDOW_MS = 5 * 60000;
var MAX_CODEX_TURNS = 64;
var MAX_CODEX_RESPONSE_KEYS = 64;
function localLogs() {
  const codex = process.env.CODEX_HOME || join4(homedir4(), ".codex");
  const claude = process.env.CLAUDE_CONFIG_DIR || join4(homedir4(), ".claude");
  const antigravity = process.env.ANTIGRAVITY_APP_DATA_DIR || join4(homedir4(), ".gemini", "antigravity-cli");
  const roots = [
    { provider: "codex", path: join4(codex, "sessions") },
    { provider: "codex", path: join4(codex, "archived_sessions") },
    { provider: "claude", path: join4(claude, "projects") },
    { provider: "antigravity", path: join4(antigravity, "brain") }
  ];
  if (!process.env.ANTIGRAVITY_APP_DATA_DIR) {
    roots.push({ provider: "antigravity", path: join4(homedir4(), ".gemini", "antigravity", "brain") });
  }
  return roots;
}
var hash = (value) => createHash3("sha256").update(value).digest("hex");
var shortHash = (value) => hash(value).slice(0, 16);
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
var label = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._:@/+\-]{0,199}$/i.test(value) ? value : null;
var nonEmptyString = (value) => typeof value === "string" && value.trim() ? value.trim() : "";
var toNonNegInt = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
var hasFiniteTokenField = (obj, keys) => Boolean(obj && keys.some((key) => typeof obj[key] === "number" && Number.isFinite(obj[key])));
var EFFORT_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max)$/i;
function splitModelEffort(raw) {
  const match = EFFORT_SUFFIX.exec(raw);
  return match ? { model: match[1], effort: match[2].toLowerCase() } : { model: raw, effort: null };
}
function inferModelProvider(model, fallback) {
  const lower = model.toLowerCase();
  if (lower.includes("claude"))
    return "anthropic";
  if (lower.startsWith("gpt") || /^o[1-9]\b|^o[1-9]-/.test(lower) || lower.includes("codex"))
    return "openai";
  if (lower.includes("gemini"))
    return "google";
  if (lower.includes("deepseek"))
    return "deepseek";
  if (lower.includes("grok"))
    return "xai";
  return fallback;
}
function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}
function hasAnyTokens(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0;
}
function tokenVec(tokens) {
  return [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.reasoning];
}
function sameVec(left, right) {
  return Boolean(left && right && left.length === right.length && left.every((value, i) => value === right[i]));
}
function addTokens(target, delta) {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.reasoning += delta.reasoning;
}
function subtractTokens(tokens, alreadyCounted) {
  return {
    input: Math.max(0, tokens.input - alreadyCounted.input),
    output: Math.max(0, tokens.output - alreadyCounted.output),
    cacheRead: Math.max(0, tokens.cacheRead - alreadyCounted.cacheRead),
    cacheWrite: Math.max(0, tokens.cacheWrite - alreadyCounted.cacheWrite),
    reasoning: Math.max(0, tokens.reasoning - alreadyCounted.reasoning)
  };
}
function trimMap(record, maxKeys) {
  const keys = Object.keys(record);
  if (keys.length <= maxKeys)
    return;
  for (const key of keys.slice(0, keys.length - maxKeys))
    delete record[key];
}
function claudeCacheWrite(usage) {
  if (typeof usage.cache_creation_input_tokens === "number" && Number.isFinite(usage.cache_creation_input_tokens)) {
    return toNonNegInt(usage.cache_creation_input_tokens);
  }
  const nested = object(usage.cache_creation);
  if (!nested)
    return 0;
  let sum = 0;
  for (const value of Object.values(nested))
    sum += toNonNegInt(value);
  return sum;
}
function parseClaudeLine(line, cutoff, logId) {
  if (!/"type"\s*:\s*"assistant"/.test(line))
    return;
  let event;
  try {
    event = object(JSON.parse(line));
  } catch {
    return;
  }
  if (event?.type !== "assistant")
    return;
  const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  if (!Number.isFinite(at) || at < cutoff)
    return;
  const message = object(event.message);
  const id = label(message?.id);
  const model = label(message?.model);
  if (!id || !model)
    return;
  const effort = label(event.perTurnEffort) ?? label(event.effort);
  const rawSession = nonEmptyString(event.sessionId ?? event.session_id) || logId;
  const sessionId = shortHash(`claude:${rawSession}`);
  const modelProvider = label(message?.provider) ?? inferModelProvider(model, "anthropic");
  const usage = object(message?.usage);
  const hasUsage = hasFiniteTokenField(usage, [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens"
  ]) || Boolean(object(usage?.cache_creation));
  const tokens = hasUsage && usage ? {
    input: toNonNegInt(usage.input_tokens),
    output: toNonNegInt(usage.output_tokens),
    cacheRead: toNonNegInt(usage.cache_read_input_tokens),
    cacheWrite: claudeCacheWrite(usage),
    reasoning: toNonNegInt(object(usage.output_tokens_details)?.thinking_tokens)
  } : null;
  return {
    id: hash(id),
    at,
    model,
    effort,
    modelProvider,
    sessionId,
    sourceKind: tokens ? "usage" : "turn",
    tokens
  };
}
function antigravityConversationId(filePath, logId) {
  const logsDir = dirname2(filePath);
  const sysDir = dirname2(logsDir);
  if (basename2(logsDir) === "logs" && basename2(sysDir) === ".system_generated") {
    const conv = basename2(dirname2(sysDir));
    if (conv)
      return conv;
  }
  return logId;
}
function parseAntigravityLine(line, cutoff, logId, convId) {
  if (!/"type"\s*:\s*"PLANNER_RESPONSE"/.test(line))
    return;
  let event;
  try {
    event = object(JSON.parse(line));
  } catch {
    return;
  }
  if (event?.type !== "PLANNER_RESPONSE")
    return;
  const rawAt = event.created_at ?? event.timestamp;
  const at = typeof rawAt === "string" ? Date.parse(rawAt) : NaN;
  if (!Number.isFinite(at) || at < cutoff)
    return;
  const rawModel = label(event.model);
  const step = typeof event.step_index === "number" && Number.isFinite(event.step_index) ? String(event.step_index) : label(event.step_index);
  if (!rawModel || step === null)
    return;
  const parsed = splitModelEffort(rawModel);
  const explicitEffort = label(event.effort) ?? label(event.thinking_level);
  const modelProvider = label(event.provider) ?? inferModelProvider(parsed.model, "google");
  const sessionId = shortHash(`antigravity:${convId}`);
  const hasUsage = hasFiniteTokenField(event, [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens"
  ]);
  const tokens = hasUsage ? {
    input: toNonNegInt(event.input_tokens),
    output: toNonNegInt(event.output_tokens),
    cacheRead: toNonNegInt(event.cache_read_tokens),
    cacheWrite: toNonNegInt(event.cache_write_tokens),
    reasoning: toNonNegInt(event.reasoning_tokens)
  } : null;
  return {
    id: hash(`${logId}:${step}`),
    at,
    model: parsed.model,
    effort: explicitEffort ?? parsed.effort,
    modelProvider,
    sessionId,
    sourceKind: tokens ? "usage" : "turn",
    tokens
  };
}
function codexUuidV7Ms(id) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(id);
  return match ? Number.parseInt(match[1] + match[2], 16) : null;
}
function codexNormalized(raw) {
  const inputRaw = toNonNegInt(raw.input_tokens);
  const cacheRead = toNonNegInt(raw.cached_input_tokens);
  const cacheWrite = toNonNegInt(raw.cache_write_input_tokens);
  return {
    input: Math.max(0, inputRaw - cacheRead - cacheWrite),
    output: toNonNegInt(raw.output_tokens),
    cacheRead,
    cacheWrite,
    reasoning: toNonNegInt(raw.reasoning_output_tokens)
  };
}
function codexRawTotals(raw) {
  return {
    input_tokens: toNonNegInt(raw.input_tokens),
    cached_input_tokens: toNonNegInt(raw.cached_input_tokens),
    cache_write_input_tokens: toNonNegInt(raw.cache_write_input_tokens),
    output_tokens: toNonNegInt(raw.output_tokens),
    reasoning_output_tokens: toNonNegInt(raw.reasoning_output_tokens)
  };
}
function codexCloseInTime(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right))
    return true;
  return Math.abs(left - right) <= CODEX_TWIN_WINDOW_MS;
}
function codexRememberModern(state, twin) {
  state.modernRecent ??= [];
  state.modernRecent.push(twin);
  if (state.modernRecent.length > 8)
    state.modernRecent.shift();
}
function codexTakeModernTwin(state, vec, at, cumulative, responseId, turnId) {
  const recent = state.modernRecent;
  if (!recent?.length)
    return null;
  for (let i = recent.length - 1;i >= 0; i -= 1) {
    const candidate = recent[i];
    const cumulativeOk = !candidate.cumulative || !cumulative || sameVec(candidate.cumulative, cumulative);
    if (sameVec(candidate.vec, vec) && codexCloseInTime(candidate.at, at) && cumulativeOk && (!responseId || !candidate.responseId || responseId === candidate.responseId) && (!turnId || !candidate.turnId || turnId === candidate.turnId)) {
      recent.splice(i, 1);
      return candidate.key;
    }
  }
  return null;
}
function codexMatchesPendingTwin(pending, vec, at, cumulative, responseId, turnId) {
  if (!pending)
    return null;
  if (!sameVec(pending.vec, vec) || !codexCloseInTime(pending.at, at))
    return null;
  if (responseId && pending.responseId && responseId !== pending.responseId)
    return null;
  if (pending.cumulative && cumulative && !sameVec(pending.cumulative, cumulative))
    return null;
  if (turnId && pending.turnId && turnId !== pending.turnId)
    return null;
  return pending.key;
}
function parseCodexLine(line, cutoff, logId, state) {
  if (!/"type"\s*:\s*"(session_meta|turn_context|token_usage_record|event_msg)"/.test(line))
    return;
  if (/"type"\s*:\s*"event_msg"/.test(line) && !/"type"\s*:\s*"(token_count|task_started)"/.test(line))
    return;
  let event;
  try {
    event = object(JSON.parse(line));
  } catch {
    return;
  }
  if (!event)
    return;
  const payload = object(event.payload) ?? {};
  const rawAt = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  const at = Number.isFinite(rawAt) ? rawAt : state.fallbackAt ?? NaN;
  if (state.forkReplay && typeof state.forkStartMs === "number" && (event.type === "turn_context" || event.type === "event_msg" && payload.type === "task_started")) {
    const turnId = nonEmptyString(payload.turn_id ?? payload.root_turn_id);
    const turnMs = codexUuidV7Ms(turnId);
    if (turnMs !== null && turnMs > state.forkStartMs) {
      state.forkReplay = false;
      state.pendingTwin = null;
      state.modernRecent = [];
    }
  }
  if (event.type === "session_meta") {
    const threadId = nonEmptyString(payload.id ?? payload.session_id ?? payload.thread_id);
    if (!state.sessionHash) {
      state.sessionHash = shortHash(`codex:${threadId || logId}`);
      const forkStartMs = threadId ? codexUuidV7Ms(threadId) : null;
      if (forkStartMs !== null && nonEmptyString(payload.forked_from_id ?? payload.parent_thread_id)) {
        state.forkReplay = true;
        state.forkStartMs = forkStartMs;
      }
    }
    if (!state.modelProvider) {
      state.modelProvider = label(payload.model_provider) ?? "openai";
    }
    if (state.fallbackAt === undefined) {
      const headerAt = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : rawAt;
      if (Number.isFinite(headerAt))
        state.fallbackAt = headerAt;
    }
    return;
  }
  if (event.type === "turn_context") {
    const turnId = label(payload.turn_id) ?? label(payload.root_turn_id);
    const model = label(payload.model);
    const effort = label(payload.effort);
    if (model)
      state.model = model;
    if (effort !== null || model)
      state.effort = effort;
    if (turnId && (model || state.model)) {
      state.turns ??= {};
      state.turns[turnId] = { model: model ?? state.model, effort: effort ?? state.effort ?? null };
      trimMap(state.turns, MAX_CODEX_TURNS);
    }
    if (state.forkReplay || !Number.isFinite(at) || at < cutoff)
      return;
    if (turnId && model) {
      return {
        id: hash(turnId),
        at,
        model,
        effort,
        modelProvider: state.modelProvider ?? inferModelProvider(model, "openai"),
        sessionId: state.sessionHash ?? shortHash(`codex:${logId}`),
        sourceKind: "turn",
        tokens: null
      };
    }
    return;
  }
  const sessionHash = (() => {
    const tid = nonEmptyString(payload.thread_id ?? payload.session_id ?? payload.threadId ?? payload.sessionId);
    return tid ? shortHash(`codex:${tid}`) : state.sessionHash ?? shortHash(`codex:${logId}`);
  })();
  if (event.type === "token_usage_record") {
    const threadRaw = object(payload.thread_token_usage);
    if (state.forkReplay && threadRaw) {
      state.legacyTotals = codexRawTotals(threadRaw);
      state.modernPending = zeroTokens();
    }
    const usage = object(payload.usage);
    if (!usage)
      return;
    const tokens = codexNormalized(usage);
    if (!hasAnyTokens(tokens))
      return;
    const turnId = nonEmptyString(payload.turn_id ?? payload.root_turn_id);
    const responseId = nonEmptyString(payload.response_id);
    const cumulativeRaw = threadRaw ?? object(payload.turn_token_usage);
    const cumulative = cumulativeRaw ? tokenVec(codexNormalized(cumulativeRaw)) : null;
    const vec = tokenVec(tokens);
    let dedupKey = responseId ? hash(`codex:resp:${responseId}`) : hash(`codex:turn:${sessionHash}:${turnId}:${String(event.timestamp ?? "")}:${vec.join(",")}`);
    const twinKey = codexMatchesPendingTwin(state.pendingTwin, vec, at, cumulative, responseId, turnId);
    if (responseId && state.responseKeys?.[responseId]) {
      dedupKey = state.responseKeys[responseId];
    } else if (twinKey) {
      dedupKey = twinKey;
      if (responseId) {
        state.responseKeys ??= {};
        state.responseKeys[responseId] = dedupKey;
        trimMap(state.responseKeys, MAX_CODEX_RESPONSE_KEYS);
      }
    }
    if (state.forkReplay) {
      if (!threadRaw && !twinKey) {
        state.modernPending ??= zeroTokens();
        addTokens(state.modernPending, tokens);
      }
      state.pendingTwin = null;
      codexRememberModern(state, { key: dedupKey, vec, at, cumulative, responseId, turnId });
      return;
    }
    if (!twinKey) {
      state.modernPending ??= zeroTokens();
      addTokens(state.modernPending, tokens);
    }
    state.pendingTwin = null;
    codexRememberModern(state, { key: dedupKey, vec, at, cumulative, responseId, turnId });
    if (!Number.isFinite(at) || at < cutoff)
      return;
    const ctx = turnId && state.turns?.[turnId] || { model: state.model ?? "unknown", effort: state.effort ?? null };
    return {
      id: dedupKey,
      at,
      model: ctx.model,
      effort: ctx.effort,
      modelProvider: state.modelProvider ?? inferModelProvider(ctx.model, "openai"),
      sessionId: sessionHash,
      sourceKind: "usage",
      tokens
    };
  }
  if (event.type === "event_msg" && payload.type === "token_count") {
    const info = object(payload.info);
    if (!info)
      return;
    const totalsRaw = object(info.total_token_usage);
    const lastRaw = object(info.last_token_usage);
    const turnId = nonEmptyString(payload.turn_id ?? payload.root_turn_id);
    const responseId = nonEmptyString(payload.response_id);
    if (state.forkReplay && totalsRaw) {
      const current = codexRawTotals(totalsRaw);
      state.legacyTotals = current;
      state.modernPending = zeroTokens();
      state.pendingTwin = null;
      if (lastRaw) {
        const lastTokens = codexNormalized(lastRaw);
        const key = hash(`codex:legacy:${sessionHash}:${String(event.timestamp ?? "")}:${Object.values(current).join(",")}`);
        const twin = {
          key,
          vec: tokenVec(lastTokens),
          at,
          cumulative: tokenVec(codexNormalized(totalsRaw)),
          responseId,
          turnId
        };
        codexRememberModern(state, twin);
        state.pendingTwin = twin;
      }
      return;
    }
    state.pendingTwin = null;
    let deltaRaw;
    let keySeed;
    let reset = false;
    if (totalsRaw) {
      const current = codexRawTotals(totalsRaw);
      const prev = state.legacyTotals;
      const fields = [
        "input_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "output_tokens",
        "reasoning_output_tokens"
      ];
      reset = Boolean(prev && fields.some((field) => current[field] < prev[field]));
      const delta = {};
      for (const field of fields) {
        delta[field] = !prev || reset ? current[field] : current[field] - prev[field];
      }
      state.legacyTotals = current;
      deltaRaw = delta;
      keySeed = `codex:legacy:${sessionHash}:${String(event.timestamp ?? "")}:${fields.map((f) => current[f]).join(",")}`;
    } else if (lastRaw) {
      deltaRaw = lastRaw;
      const norm = codexNormalized(lastRaw);
      keySeed = `codex:last:${sessionHash}:${String(event.timestamp ?? "")}:${tokenVec(norm).join(",")}`;
    } else {
      return;
    }
    let tokens = codexNormalized(deltaRaw);
    const cumulative = totalsRaw ? tokenVec(codexNormalized(totalsRaw)) : null;
    if (totalsRaw) {
      if (!reset && state.modernPending) {
        tokens = subtractTokens(tokens, state.modernPending);
      }
      state.modernPending = zeroTokens();
    }
    if (!hasAnyTokens(tokens))
      return;
    const vec = tokenVec(tokens);
    let dedupKey = state.forkReplay && responseId ? hash(`codex:resp:${responseId}`) : hash(keySeed);
    let usedModernTwin = false;
    if (!reset) {
      const modernKey = codexTakeModernTwin(state, vec, at, cumulative, responseId, turnId);
      if (modernKey) {
        dedupKey = modernKey;
        usedModernTwin = true;
      }
    }
    if (state.forkReplay) {
      if (!usedModernTwin && !state.legacyTotals) {
        state.modernPending ??= zeroTokens();
        addTokens(state.modernPending, tokens);
      }
      state.pendingTwin = { key: dedupKey, vec, at, cumulative, responseId, turnId };
      return;
    }
    if (!usedModernTwin) {
      state.pendingTwin = { key: dedupKey, vec, at, cumulative, responseId, turnId };
    }
    if (!Number.isFinite(at) || at < cutoff)
      return;
    const ctx = turnId && state.turns?.[turnId] || { model: state.model ?? "unknown", effort: state.effort ?? null };
    return {
      id: dedupKey,
      at,
      model: ctx.model,
      effort: ctx.effort,
      modelProvider: state.modelProvider ?? inferModelProvider(ctx.model, "openai"),
      sessionId: sessionHash,
      sourceKind: "usage",
      tokens
    };
  }
}
async function readLog(path, start, end, provider, cutoff, logId, codexState) {
  const usage = [];
  let offset = start;
  let pending = Buffer.alloc(0);
  const convId = provider === "antigravity" ? antigravityConversationId(path, logId) : "";
  for await (const chunk of Bun.file(path).slice(start, end).stream()) {
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    let lineStart = 0;
    for (let newline = bytes.indexOf(10);newline >= 0; newline = bytes.indexOf(10, lineStart)) {
      const line = bytes.toString("utf8", lineStart, newline);
      const entry = provider === "codex" ? parseCodexLine(line, cutoff, logId, codexState) : provider === "claude" ? parseClaudeLine(line, cutoff, logId) : parseAntigravityLine(line, cutoff, logId, convId);
      if (entry)
        usage.push(entry);
      lineStart = newline + 1;
    }
    offset += lineStart;
    pending = bytes.subarray(lineStart);
  }
  return { usage, offset };
}
function unavailable(error) {
  return ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error?.code ?? "");
}
async function logFiles({ provider, path }) {
  const root = resolve(path);
  const entries = await readdir(root, { recursive: provider !== "antigravity", withFileTypes: true }).catch((error) => {
    if (!unavailable(error))
      throw error;
    return [];
  });
  if (provider === "antigravity") {
    const logs = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "transcript.jsonl")
        logs.push(join4(entry.parentPath, entry.name));
      else if (entry.isDirectory())
        logs.push(join4(entry.parentPath, entry.name, ".system_generated", "logs", "transcript.jsonl"));
    }
    return logs;
  }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join4(entry.parentPath, entry.name));
}
function readModelUsage(from, through, file = historyFile()) {
  if (from > through || !existsSync5(file))
    return [];
  const db = openHistoryDatabase(file, true);
  try {
    if (!db.query("SELECT 1 FROM sqlite_schema WHERE name = 'model_usage'").get())
      return [];
    return db.query(`
      SELECT provider, observed_at AS at, model, effort FROM model_usage
      WHERE observed_at BETWEEN ? AND ? ORDER BY observed_at
    `).all(from, through);
  } finally {
    db.close();
  }
}
async function syncModelUsage(file = historyFile(), roots = localLogs(), now = Date.now(), options = {}) {
  const cutoff = options.maxLookbackMs != null && Number.isFinite(options.maxLookbackMs) ? now - options.maxLookbackMs : 0;
  const budgetMs = options.budgetMs ?? DEFAULT_SYNC_BUDGET_MS;
  const deadline = Number.isFinite(budgetMs) && budgetMs > 0 ? Date.now() + budgetMs : Infinity;
  const db = openHistoryDatabase(file);
  try {
    const lookup = db.query("SELECT byte_offset, modified_at, file_size, parser_version, state_json FROM model_log_offsets WHERE log_id = ?");
    const insert = db.query(`
      INSERT INTO model_usage (
        provider, event_id, observed_at, model, effort,
        model_provider, session_id, source_kind,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, event_id) DO UPDATE SET
        observed_at = min(model_usage.observed_at, excluded.observed_at),
        effort = coalesce(model_usage.effort, excluded.effort),
        model_provider = coalesce(model_usage.model_provider, excluded.model_provider),
        session_id = coalesce(model_usage.session_id, excluded.session_id),
        source_kind = CASE
          WHEN excluded.input_tokens IS NOT NULL THEN 'usage'
          ELSE coalesce(model_usage.source_kind, excluded.source_kind)
        END,
        input_tokens = CASE
          WHEN excluded.input_tokens IS NULL THEN model_usage.input_tokens
          WHEN model_usage.input_tokens IS NULL THEN excluded.input_tokens
          ELSE max(model_usage.input_tokens, excluded.input_tokens)
        END,
        output_tokens = CASE
          WHEN excluded.output_tokens IS NULL THEN model_usage.output_tokens
          WHEN model_usage.output_tokens IS NULL THEN excluded.output_tokens
          ELSE max(model_usage.output_tokens, excluded.output_tokens)
        END,
        cache_read_tokens = CASE
          WHEN excluded.cache_read_tokens IS NULL THEN model_usage.cache_read_tokens
          WHEN model_usage.cache_read_tokens IS NULL THEN excluded.cache_read_tokens
          ELSE max(model_usage.cache_read_tokens, excluded.cache_read_tokens)
        END,
        cache_write_tokens = CASE
          WHEN excluded.cache_write_tokens IS NULL THEN model_usage.cache_write_tokens
          WHEN model_usage.cache_write_tokens IS NULL THEN excluded.cache_write_tokens
          ELSE max(model_usage.cache_write_tokens, excluded.cache_write_tokens)
        END,
        reasoning_tokens = CASE
          WHEN excluded.reasoning_tokens IS NULL THEN model_usage.reasoning_tokens
          WHEN model_usage.reasoning_tokens IS NULL THEN excluded.reasoning_tokens
          ELSE max(model_usage.reasoning_tokens, excluded.reasoning_tokens)
        END
    `);
    const save = db.query(`
      INSERT INTO model_log_offsets (log_id, byte_offset, modified_at, file_size, parser_version, state_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (log_id) DO UPDATE SET
        byte_offset = excluded.byte_offset,
        modified_at = excluded.modified_at,
        file_size = excluded.file_size,
        parser_version = excluded.parser_version,
        state_json = excluded.state_json
      WHERE excluded.parser_version > model_log_offsets.parser_version
         OR excluded.modified_at > model_log_offsets.modified_at
         OR (excluded.modified_at = model_log_offsets.modified_at AND excluded.byte_offset >= model_log_offsets.byte_offset)
         OR (model_log_offsets.file_size IS NOT NULL AND excluded.file_size < model_log_offsets.file_size)
    `);
    const commit = db.transaction((provider, id, modifiedAt, fileSize, delta, stateJson) => {
      for (const row of delta.usage) {
        insert.run(provider, row.id, row.at, row.model, row.effort, row.modelProvider, row.sessionId, row.sourceKind, row.tokens ? row.tokens.input : null, row.tokens ? row.tokens.output : null, row.tokens ? row.tokens.cacheRead : null, row.tokens ? row.tokens.cacheWrite : null, row.tokens ? row.tokens.reasoning : null);
      }
      save.run(id, delta.offset, modifiedAt, fileSize, PARSER_VERSION, stateJson);
    });
    const dirty = [];
    let totalFiles = 0;
    for (const root of roots) {
      const { provider } = root;
      for (const log of await logFiles(root)) {
        try {
          const info = await stat(log);
          if (!info.isFile())
            continue;
          if (cutoff > 0 && info.mtimeMs < cutoff)
            continue;
          totalFiles += 1;
          const id = hash(`${provider}:${log}:${info.dev}:${info.ino}:${info.birthtimeMs}`);
          const previous = lookup.get(id) ?? null;
          const upToDate = previous && previous.parser_version >= PARSER_VERSION && previous.byte_offset === info.size && previous.modified_at === info.mtimeMs && (previous.file_size == null || previous.file_size === info.size);
          if (upToDate)
            continue;
          const canResume = Boolean(previous && previous.parser_version >= PARSER_VERSION && previous.byte_offset > 0 && previous.byte_offset < info.size && (previous.file_size == null || info.size >= previous.file_size));
          const start = canResume ? previous.byte_offset : 0;
          if (start === info.size && previous && previous.parser_version >= PARSER_VERSION)
            continue;
          dirty.push({ provider, path: log, id, size: info.size, mtimeMs: info.mtimeMs, start, previous });
        } catch (error) {
          if (!unavailable(error))
            throw error;
        }
      }
    }
    dirty.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let processedFiles = 0;
    let scannedBytes = 0;
    for (const candidate of dirty) {
      if (processedFiles > 0 && Date.now() >= deadline)
        break;
      let codexState = {};
      if (candidate.provider === "codex" && candidate.start > 0 && candidate.previous?.state_json) {
        try {
          codexState = JSON.parse(candidate.previous.state_json);
        } catch {
          codexState = {};
          candidate.start = 0;
        }
      }
      try {
        const delta = await readLog(candidate.path, candidate.start, candidate.size, candidate.provider, cutoff, candidate.id, codexState);
        scannedBytes += Math.max(0, candidate.size - candidate.start);
        const stateJson = candidate.provider === "codex" && Object.keys(codexState).length > 0 ? JSON.stringify(codexState) : null;
        const shouldCommit = delta.offset > candidate.start || candidate.size === 0 && (candidate.previous?.parser_version ?? 0) < PARSER_VERSION;
        if (shouldCommit) {
          commit.immediate(candidate.provider, candidate.id, candidate.mtimeMs, candidate.size, delta, stateJson);
        }
        processedFiles += 1;
      } catch (error) {
        if (!unavailable(error))
          throw error;
        processedFiles += 1;
      }
    }
    return {
      pendingFiles: Math.max(0, dirty.length - processedFiles),
      processedFiles,
      totalFiles,
      scannedBytes
    };
  } finally {
    db.close();
  }
}

// usage-summary.ts
var SHORT_NAMES = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "AGY",
  grok: "Grok",
  copilot: "Copilot",
  opencode: "OpenCode"
};
function summaryParts(report) {
  const parts = [];
  if (report.claude) {
    const s = report.claude.windows.find((w) => w.label.includes("5h")) ?? report.claude.windows[0];
    if (s) {
      parts.push({ name: "Claude", remaining: Math.max(0, 100 - Math.round(s.used_percent)) });
    }
  }
  if (report.codex) {
    const s = report.codex.windows.find((w) => w.label.includes("5h")) ?? report.codex.windows[0];
    if (s) {
      parts.push({ name: "Codex", remaining: Math.max(0, 100 - Math.round(s.used_percent)) });
    }
  }
  if (report.antigravity) {
    const fiveHourValues = [];
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
  if (parts.length === 0 && report.others?.length) {
    for (const p of report.others) {
      const name = SHORT_NAMES[p.id] ?? p.id.charAt(0).toUpperCase() + p.id.slice(1);
      if (p.problem === "expired") {
        parts.push({ name, remaining: null, note: "auth expired" });
        continue;
      }
      const sessionWindow = p.windows.find((w) => w.kind === "session") ?? p.windows[0];
      if (!sessionWindow)
        continue;
      parts.push({ name, remaining: Math.max(0, 100 - Math.round(sessionWindow.used_percent)) });
    }
  }
  return parts;
}
function formatSummary(parts) {
  return parts.map((part) => part.note ? `${part.name}: ${part.note}` : `${part.name} ${part.remaining}%`).join(" \xB7 ");
}

// herdr-app/usage-json.ts
var DAY_MS = 24 * 60 * 60000;
var mode = process.argv[2];
function flagValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}
if (mode === "--history") {
  const cached = await getCachedReport(DAY_MS, { allowPartial: true });
  const now = Date.now();
  const burndowns = labelAccounts(readBurndowns(undefined, now), accountNames(cached));
  const start = Math.min(...burndowns.map((chart) => chart.start));
  console.log(JSON.stringify({ burndowns, modelUsage: readModelUsage(start, now) }));
  process.exit(0);
}
if (mode === "--historical") {
  const now = Date.now();
  const shouldSync = flagValue("sync") === "1";
  let backfill = { pendingFiles: 0, totalFiles: 0 };
  if (shouldSync) {
    const stats = await syncModelUsage(undefined, undefined, now, { budgetMs: 3500 }).catch((error) => {
      console.warn("Couldn't sync model usage:", error instanceof Error ? error.message : error);
      return null;
    });
    if (stats)
      backfill = { pendingFiles: stats.pendingFiles, totalFiles: stats.totalFiles };
  }
  const offsetRaw = Number(flagValue("offset") ?? "0");
  const payload = readHistorical({
    horizon: flagValue("horizon") ?? "m",
    offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
    provider: flagValue("provider") ?? "all",
    model: flagValue("model") ?? "all",
    includeCache: flagValue("cache") !== "0",
    now
  }, undefined, backfill);
  console.log(JSON.stringify(payload));
  process.exit(0);
}
var recent = async () => {
  const cached = await getCachedReport(180000);
  return cached?.read_at && Object.keys(cached.read_at).length ? cached : null;
};
var report = mode === "--cached" ? await getCachedReport(DAY_MS) ?? await getCachedReport(DAY_MS, { allowPartial: true }) : (mode === "--refresh" ? null : await recent()) ?? await fetchDetailedReport();
try {
  if (report)
    recordReport(report);
} catch (error) {
  console.warn("Couldn't record allowance history:", error instanceof Error ? error.message : error);
}
if (mode !== "--cached") {
  await syncModelUsage().catch((error) => {
    console.warn("Couldn't sync model usage:", error instanceof Error ? error.message : error);
  });
}
var parts = report ? summaryParts(report) : [];
console.log(JSON.stringify({
  report,
  summary: formatSummary(parts),
  parts
}));
