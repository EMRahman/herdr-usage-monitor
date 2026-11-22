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

// history.ts
import { appendFileSync, closeSync as closeSync2, fstatSync, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync, readSync as readSync2, renameSync, writeFileSync as writeFileSync3 } from "fs";
import { homedir as homedir3 } from "os";
import { dirname, join as join3 } from "path";

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
var KEEP_MS = 8 * DAY2;
var BUCKETS = 180;
function historyFile() {
  if (process.env["HERDR_USAGE_HISTORY_FILE"])
    return process.env["HERDR_USAGE_HISTORY_FILE"];
  const data = process.env["XDG_DATA_HOME"] || join3(homedir3(), ".local", "share");
  return join3(data, "herdr-usage-monitor", "history.jsonl");
}
var round = (value) => Math.round(value * 10) / 10;
function samplesFrom(report) {
  const samples = [];
  for (const [id, provider] of [["claude", report.claude], ["codex", report.codex]]) {
    for (const w of provider?.windows ?? []) {
      samples.push({ p: id, w: w.label, left: round(100 - w.used_percent), reset: w.resets_at ?? null });
    }
  }
  for (const group of report.antigravity?.groups ?? []) {
    for (const b of group.buckets ?? []) {
      samples.push({ p: "antigravity", g: group.name, w: b.label, left: round(b.remaining_percent), reset: b.resets_at ?? null });
    }
  }
  for (const provider of report.others ?? []) {
    for (const w of provider.windows ?? []) {
      samples.push({
        p: provider.id,
        ...w.scope ? { g: w.scope } : {},
        w: w.kind,
        left: round(100 - w.used_percent),
        reset: w.resets_at ?? null
      });
    }
  }
  return samples.filter((s) => Number.isFinite(s.left));
}
function recordHistory(samples, t = Date.now(), file = historyFile()) {
  if (samples.length === 0)
    return;
  try {
    mkdirSync2(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ t, s: samples })}
`);
    pruneHistory(file, t);
  } catch {}
}
var TAIL_BYTES = 256 * 1024;
function recentReadings(file = historyFile()) {
  const last = new Map;
  let since = -Infinity;
  let fd;
  try {
    fd = openSync2(file, "r");
  } catch {
    return { last, since };
  }
  try {
    const size = fstatSync(fd).size;
    const offset = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - offset);
    const read = readSync2(fd, buffer, 0, buffer.length, offset);
    const lines = buffer.subarray(0, read).toString("utf8").split(`
`);
    if (offset > 0) {
      lines.shift();
      since = Infinity;
    }
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (offset > 0)
          since = Math.min(since, entry.t);
        for (const s of entry.s)
          last.set(s.p, Math.max(last.get(s.p) ?? -Infinity, entry.t));
      } catch {}
    }
  } finally {
    closeSync2(fd);
  }
  return { last, since };
}
function recordReport(report, file = historyFile()) {
  const readAt = report.read_at;
  if (!readAt)
    return;
  const { last, since } = recentReadings(file);
  const lines = new Map;
  for (const sample of samplesFrom(report)) {
    const t = readAt[sample.p];
    if (!t || t < since || t <= (last.get(sample.p) ?? -Infinity))
      continue;
    if (!lines.has(t))
      lines.set(t, []);
    lines.get(t).push(sample);
  }
  for (const [t, samples] of [...lines].sort((a, b) => a[0] - b[0]))
    recordHistory(samples, t, file);
}
function firstTime(file) {
  const fd = openSync2(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync2(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, read).toString("utf8").split(`
`)[0];
    const t = JSON.parse(line ?? "").t;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  } finally {
    closeSync2(fd);
  }
}
function pruneHistory(file, now = Date.now()) {
  const oldest = firstTime(file);
  if (oldest !== null && now - oldest < KEEP_MS + DAY2)
    return;
  const kept = readFileSync(file, "utf8").split(`
`).filter((line) => {
    try {
      return JSON.parse(line).t >= now - KEEP_MS;
    } catch {
      return false;
    }
  });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync3(temp, kept.map((line) => `${line}
`).join(""));
  renameSync(temp, file);
}
function readHistory(file = historyFile()) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split(`
`)) {
    if (!line)
      continue;
    try {
      const entry = JSON.parse(line);
      if (Number.isFinite(entry.t) && Array.isArray(entry.s))
        entries.push(entry);
    } catch {}
  }
  return entries.sort((a, b) => a.t - b.t);
}
var keyOf = (s) => `${s.p}\x00${s.g ?? ""}\x00${s.w}`;
var CHARTED = new Set([5 * HOUR2, 7 * DAY2]);
function burndowns(entries, now = Date.now()) {
  const series = new Map;
  for (const entry of entries) {
    for (const s of entry.s) {
      const key = keyOf(s);
      if (!series.has(key))
        series.set(key, []);
      series.get(key).push({ t: entry.t, s });
    }
  }
  const result = [];
  for (const readings of series.values()) {
    const latest = readings.at(-1);
    if (now - latest.t > DAY2)
      continue;
    const length = windowLength(latest.s.w);
    if (!length || !CHARTED.has(length))
      continue;
    const reset = Date.parse(latest.s.reset ?? "");
    const end = Number.isFinite(reset) ? reset : now;
    const start = end - length;
    const inWindow = readings.filter((r) => r.t >= start && r.t <= end);
    result.push({
      provider: latest.s.p,
      ...latest.s.g ? { group: latest.s.g } : {},
      label: latest.s.w,
      length,
      start,
      end,
      left: latest.s.left,
      reset: latest.s.reset,
      runs: runs(inWindow.map((r) => [r.t, r.s.left]), length, Math.min(now, end))
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
if (mode === "--history") {
  console.log(JSON.stringify({ burndowns: burndowns(readHistory()) }));
  process.exit(0);
}
var report = mode === "--cached" ? await getCachedReport(DAY_MS) ?? await getCachedReport(DAY_MS, { allowPartial: true }) : (mode === "--refresh" ? null : await getCachedReport(180000)) ?? await fetchDetailedReport();
if (report)
  recordReport(report);
var parts = report ? summaryParts(report) : [];
console.log(JSON.stringify({
  report,
  summary: formatSummary(parts),
  parts
}));
