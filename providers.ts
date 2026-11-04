/**
 * Standalone, read-only CLI credential discovery and usage readers.
 *
 * OAuth tokens are intentionally never refreshed here: Claude, Codex, Cursor, and Grok rotate
 * refresh tokens, so refreshing outside the CLI would log the user out.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { GenericProvider } from "./fetcher.ts";

const MAX_READ_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 4_000;
const USER_AGENT = "herdr-usage-monitor";

export type KeychainRead = { status: "found"; value: string } | { status: "missing" } | { status: "locked" };

export interface Account {
  id: string;
  label: string | null;
}

export interface SignIn {
  source: string;
  token: string;
  expiresAt: number | null;
  plan?: string | null;
  chatgptAccount?: string | null;
  fallbacks?: string[];
  account?: Account | null;
  cliOnly?: boolean;
  editorAccounts?: string[];
}

type RawSignIn = Omit<SignIn, "source">;
type FoundSignIn = SignIn | { source: string; locked: true; account?: Account | null };

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};
const percent = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

export function resolveBinary(name: string): string | null {
  const found = Bun.which(name);
  if (found) return found;
  const extraDirs = [
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of extraDirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function siblingDirs(home: string, prefix: string): string[] {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(home, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function parseJson(source: string | null): unknown {
  if (source === null) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    let size = 0;
    for (let read = 1; read > 0 && size <= MAX_READ_BYTES; size += read) {
      read = readSync(fd, buffer, size, buffer.length - size, null);
    }
    return size > MAX_READ_BYTES ? null : buffer.toString("utf8", 0, size);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function readCapped(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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

function isoTime(value: unknown): string | null {
  const n = number(value);
  if (n !== null && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const s = text(value);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function epochMs(value: unknown): number | null {
  const iso = isoTime(value);
  return iso === null ? null : Date.parse(iso);
}

function jwtClaims(token: string): Json {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

function jwtExpiry(token: string): number | null {
  const exp = number(jwtClaims(token)["exp"]);
  return exp === null ? null : exp * 1000;
}

function kindOf(seconds: number | null, fallback: string): string {
  if (seconds === null || seconds <= 0) return fallback;
  if (seconds <= 6 * 3600) return "session";
  if (seconds <= 36 * 3600) return "day";
  if (seconds <= 8 * 86400) return "week";
  return "month";
}

/** Keychain services whose read hung on an unanswered prompt: not asked again in this process. */
const promptedServices = new Set<string>();
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let loginSessionJobs = 0;

async function launchctl(args: string[]): Promise<number> {
  const child = Bun.spawn(["launchctl", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
  try {
    return await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a macOS Keychain item inside the user's gui/<uid> launchd domain when the current process
 * runs in a detached daemon session where direct keychain reads return exit code 36.
 */
async function readKeychainInLoginSession(service: string, account?: string): Promise<string | null> {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return null;
  const args = ["/usr/bin/security", "find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
  const domain = `gui/${process.getuid()}`;
  const label = `dev.herdr.usage-monitor.keychain.${process.pid}.${Date.now()}.${++loginSessionJobs}`;
  const dir = mkdtempSync(join(tmpdir(), "herdr-usage-keychain-"));
  const fifo = join(dir, "out");
  const plist = join(dir, "job.plist");
  let pipe: FileHandle | undefined;
  try {
    if (Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode !== 0) return null;
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>StandardOutPath</key><string>${xml(fifo)}</string><key>StandardErrorPath</key><string>/dev/null</string><key>RunAtLoad</key><true/></dict></plist>
`,
      { mode: 0o600 },
    );
    const handle = (pipe = await open(fifo, "r+"));
    let gaveUp = false;
    const giveUp = () => {
      gaveUp = true;
      try {
        writeSync(handle.fd, "\n");
      } catch {}
    };
    const reading = (async () => {
      const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
      let size = 0;
      let line = -1;
      while (line === -1 && size <= MAX_READ_BYTES) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        line = buffer.subarray(0, size).indexOf(0x0a);
      }
      return line === -1 ? null : buffer.toString("utf8", 0, line).trim();
    })().catch(() => null);
    const timer = setTimeout(giveUp, COMMAND_TIMEOUT_MS);
    try {
      if ((await launchctl(["bootstrap", domain, plist]).catch(() => -1)) !== 0) giveUp();
      const value = await reading;
      return gaveUp || !value ? null : value;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  } finally {
    await launchctl(["bootout", `${domain}/${label}`]).catch(() => undefined);
    await pipe?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function readKeychain(service: string, account?: string): Promise<KeychainRead> {
  if (process.platform !== "darwin") return { status: "missing" };
  if (promptedServices.has(service)) return { status: "locked" };
  const child = Bun.spawn(
    ["/usr/bin/security", "find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, COMMAND_TIMEOUT_MS);
  try {
    const output = await readCapped(child.stdout);
    if (output === null) child.kill();
    const code = await child.exited;
    clearTimeout(timer);
    if (output === null) return { status: "missing" };
    if (code === 0 && output.trim()) return { status: "found", value: output.trim() };
    if (code === 44 && !timedOut) return { status: "missing" };
    if (code === 36 && !timedOut) {
      const gui = await readKeychainInLoginSession(service, account);
      if (gui !== null) return { status: "found", value: gui };
    }
    if (timedOut) promptedServices.add(service);
    return { status: "locked" };
  } catch {
    return { status: "missing" };
  } finally {
    clearTimeout(timer);
  }
}

export async function runCommand(argv: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<string | null> {
  const bin = resolveBinary(argv[0]!);
  if (!bin) return null;
  try {
    const child = Bun.spawn([bin, ...argv.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const output = await readCapped(child.stdout);
      if (output === null) child.kill();
      const code = await child.exited;
      return code === 0 && output !== null ? output.trim() : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function fromKeychain(
  service: string,
  accounts: Array<string | undefined>,
  parse: (value: string) => RawSignIn | null,
): Promise<RawSignIn | "locked" | null> {
  if (process.platform !== "darwin") return null;
  for (const account of accounts) {
    const found = await readKeychain(service, account);
    if (found.status === "locked") return "locked";
    if (found.status === "found") {
      const signIn = parse(found.value);
      if (signIn) return signIn;
    }
  }
  return null;
}

function keychainFound(result: RawSignIn | "locked" | null, source: string, account: Account | null = null): FoundSignIn[] {
  if (result === null) return [];
  return [result === "locked" ? { source, locked: true, account } : { ...result, account: result.account ?? account, source }];
}

function keychainOrFile(
  keychain: RawSignIn | "locked" | null,
  file: RawSignIn | null,
  source: string,
  account: Account | null = null,
): FoundSignIn[] {
  const item = keychain && keychain !== "locked" ? keychain : null;
  const fileIsLater =
    file != null && item != null && file.expiresAt != null && item.expiresAt != null && file.expiresAt > item.expiresAt;
  if (item && !fileIsLater) return keychainFound(item, source, account);
  return file ? [{ ...file, account: file.account ?? account, source }] : keychainFound(keychain, source, account);
}

function unlockedSignIns(found: FoundSignIn[]): SignIn[] {
  const now = Date.now();
  const valid = found.filter((item): item is SignIn => !("locked" in item) && Boolean(item.token));
  // Prefer non-expired tokens first
  return valid.sort((a, b) => {
    const aExpired = a.expiresAt !== null && a.expiresAt <= now ? 1 : 0;
    const bExpired = b.expiresAt !== null && b.expiresAt <= now ? 1 : 0;
    return aExpired - bExpired;
  });
}

// ---- Claude Code ----

function claudeAccount(path: string): Account | null {
  const oauth = record(record(parseJson(readText(path)))["oauthAccount"]);
  const id = text(oauth["accountUuid"]);
  return id ? { id, label: text(oauth["emailAddress"]) } : null;
}

function claudeSignIn(source: string | null): RawSignIn | null {
  const oauth = record(record(parseJson(source))["claudeAiOauth"]);
  const token = text(oauth["accessToken"]);
  return token ? { token, expiresAt: number(oauth["expiresAt"]), plan: text(oauth["subscriptionType"]) } : null;
}

export async function getClaudeSignIns(): Promise<SignIn[]> {
  const home = homedir();
  const user = process.env["USER"];
  const homes = [{ source: "default", service: "Claude Code-credentials", dir: join(home, ".claude"), config: join(home, ".claude.json") }];
  const extraDirs = [process.env["CLAUDE_CONFIG_DIR"], ...siblingDirs(home, ".claude-")].filter((d): d is string => Boolean(d));
  for (const dir of new Set(extraDirs)) {
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    homes.push({ source: dir, service: `Claude Code-credentials-${hash}`, dir, config: join(dir, ".claude.json") });
  }

  const found = await Promise.all(
    homes.map(async (h) => {
      const account = claudeAccount(h.config);
      const keychain = await fromKeychain(h.service, user ? [user, undefined] : [undefined], claudeSignIn);
      const file = claudeSignIn(readText(join(h.dir, ".credentials.json")));
      return keychainOrFile(keychain, file, h.source, account);
    }),
  );
  return unlockedSignIns(found.flat());
}

// ---- OpenAI Codex ----

function codexSignIn(source: string | null): RawSignIn | null {
  const tokens = record(record(parseJson(source))["tokens"]);
  const token = text(tokens["access_token"]);
  if (!token) return null;
  const claims = jwtClaims(token);
  const auth = record(claims["https://api.openai.com/auth"]);
  const workspace = text(tokens["account_id"]) ?? text(auth["chatgpt_account_id"]);
  const email =
    text(record(claims["https://api.openai.com/profile"])["email"]) ??
    text(jwtClaims(text(tokens["id_token"]) ?? "")["email"]);
  const user = text(auth["chatgpt_user_id"]) ?? text(auth["user_id"]);
  const id =
    text(auth["chatgpt_account_user_id"]) ??
    (user || workspace ? [user, workspace].filter(Boolean).join("__") : email);
  return {
    token,
    expiresAt: jwtExpiry(token),
    plan: text(auth["chatgpt_plan_type"]),
    chatgptAccount: workspace,
    account: id ? { id, label: email } : null,
  };
}

export async function getCodexSignIns(): Promise<SignIn[]> {
  const home = homedir();
  const homes = [
    process.env["CODEX_HOME"],
    join(home, ".config", "codex"),
    join(home, ".codex"),
    ...siblingDirs(home, ".codex-"),
  ];
  const found: FoundSignIn[] = [];
  for (const dir of new Set(homes.filter((d): d is string => Boolean(d)))) {
    const signIn = codexSignIn(readText(join(dir, "auth.json")));
    if (signIn) found.push({ ...signIn, source: dir });
  }
  if (found.length > 0) return unlockedSignIns(found);
  return unlockedSignIns(keychainFound(await fromKeychain("Codex Auth", [undefined], codexSignIn), "keychain"));
}

// ---- Antigravity (AGY) ----

function antigravitySignIn(value: string | null): RawSignIn | null {
  if (value === null) return null;
  const encoded = value.startsWith("go-keyring-base64:")
    ? Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8")
    : value;
  const root = record(parseJson(encoded));
  const token = record(root["token"]);
  const access = text(token["access_token"]);
  if (!access) return null;
  const idToken = text(root["id_token"]);
  const claims = idToken ? jwtClaims(idToken) : {};
  const email = text(claims["email"]);
  const sub = text(claims["sub"]);
  const account = sub || email ? { id: sub ?? email!, label: email } : null;
  return { token: access, expiresAt: epochMs(token["expiry"]), account };
}

export async function getAntigravitySignIns(): Promise<SignIn[]> {
  const home = homedir();
  const dir = process.env["ANTIGRAVITY_APP_DATA_DIR"] || join(home, ".gemini", "antigravity-cli");
  const file = antigravitySignIn(readText(join(dir, "antigravity-oauth-token")));
  const keychain = await fromKeychain("gemini", ["antigravity"], antigravitySignIn);
  return unlockedSignIns(keychainOrFile(keychain, file, "keychain"));
}

// ---- Secondary Providers (Cursor, Copilot, Grok, OpenCode) ----

function cursorDatabase(home: string): string {
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    : join(process.env["XDG_CONFIG_HOME"] || join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorAccount(token: string, email: string | null): Account | null {
  const id = text(jwtClaims(token)["sub"]);
  return id ? { id, label: email } : null;
}

function cursorAppSignIn(path: string): RawSignIn | null {
  if (!existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const value = (key: string) =>
      text(
        db!
          .query<{ value: unknown }, [string, number]>("SELECT value FROM ItemTable WHERE key = ? AND length(value) <= ?")
          .get(key, MAX_READ_BYTES)?.value,
      );
    const token = value("cursorAuth/accessToken");
    return token
      ? {
          token,
          expiresAt: jwtExpiry(token),
          plan: value("cursorAuth/stripeMembershipType"),
          account: cursorAccount(token, value("cursorAuth/cachedEmail")),
        }
      : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function fetchCursorProviders(timeoutMs: number): Promise<GenericProvider[]> {
  const home = homedir();
  const app = cursorAppSignIn(cursorDatabase(home));
  const cliEmail = text(record(record(parseJson(readText(join(home, ".cursor", "cli-config.json"))))["authInfo"])["email"]);
  const cli = await fromKeychain("cursor-access-token", [undefined], (value) => {
    const token = text(value);
    return token ? { token, expiresAt: jwtExpiry(token), account: cursorAccount(token, cliEmail) } : null;
  });

  let found: FoundSignIn[];
  if (!app) found = keychainFound(cli, "cli");
  else if (!cli || cli === "locked") found = [{ ...app, source: "app" }];
  else if (app.account?.id !== cli.account?.id) found = [{ ...app, source: "app" }, { ...cli, source: "cli" }];
  else {
    found =
      (cli.expiresAt ?? 0) > (app.expiresAt ?? 0)
        ? [{ ...cli, plan: app.plan ?? null, account: app.account, source: "cli" }]
        : [{ ...app, source: "app" }];
  }

  const results: GenericProvider[] = [];
  for (const item of unlockedSignIns(found)) {
    if (item.expiresAt !== null && item.expiresAt <= Date.now()) {
      results.push({
        id: "cursor",
        account: item.account?.label ?? "",
        plan: item.plan ?? null,
        windows: [],
        problem: "expired",
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
          "user-agent": USER_AGENT,
        },
        body: "{}",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) {
        results.push({ id: "cursor", account: item.account?.label ?? "", plan: item.plan ?? null, windows: [], problem: "expired" });
        continue;
      }
      if (!res.ok) continue;
      const body = record(await res.json());
      const plan = record(body["planUsage"]);
      const limit = number(plan["limit"]);
      const remaining = number(plan["remaining"]);
      const used = number(plan["totalPercentUsed"]) ?? (limit && remaining !== null ? ((limit - remaining) / limit) * 100 : null);
      const resetsAt = isoTime(body["billingCycleEnd"]);
      const windows = (
        [
          [used, null],
          [number(plan["autoPercentUsed"]), "Cursor models"],
          [number(plan["apiPercentUsed"]), "Other models"],
        ] as Array<[number | null, string | null]>
      )
        .filter((entry): entry is [number, string | null] => entry[0] !== null)
        .map(([share, scope]) => ({ kind: "month", scope, used_percent: percent(share), resets_at: resetsAt }));

      const onDemandLimit = number(plan["onDemandLimit"]);
      const onDemandUsed = number(plan["onDemandUsed"]);
      const bonusCredits = number(body["bonusCredits"]) ?? number(body["credits"]);
      let credits: GenericProvider["credits"] = null;
      if (onDemandLimit !== null && onDemandLimit > 0) {
        const usedPct = onDemandUsed !== null ? percent((onDemandUsed / onDemandLimit) * 100) : null;
        credits = {
          label: "Extra usage",
          balance:
            onDemandUsed !== null
              ? `$${(onDemandUsed / 100).toFixed(2)} / $${(onDemandLimit / 100).toFixed(2)}`
              : `$${(onDemandLimit / 100).toFixed(2)}`,
          used_percent: usedPct,
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
        problem: null,
      });
    } catch {}
  }
  return results;
}

interface GitHubToken {
  token: string;
  login: string | null;
  editor: boolean;
}

function copilotFileTokens(source: string | null): GitHubToken[] {
  return Object.entries(record(parseJson(source))).flatMap(([host, entry]) => {
    const token = host.startsWith("github.com") ? text(record(entry)["oauth_token"]) : null;
    return token ? [{ token, login: text(record(entry)["user"]), editor: true }] : [];
  });
}

async function ghTokens(skipSubprocess: boolean): Promise<GitHubToken[]> {
  if (skipSubprocess) return [];
  const rawStatus = await runCommand(["gh", "auth", "status", "--hostname", "github.com", "--json", "hosts"], 2500);
  const accounts = record(record(parseJson(rawStatus))["hosts"])["github.com"];
  if (!Array.isArray(accounts)) {
    const token = text(await runCommand(["gh", "auth", "token", "--hostname", "github.com"], 2000));
    return token ? [{ token, login: null, editor: false }] : [];
  }
  const tokens = await Promise.all(
    accounts.map(async (entry): Promise<GitHubToken | null> => {
      const account = record(entry);
      const login = text(account["login"]);
      if (!login || account["state"] !== "success") return null;
      const fromEnv = ["GH_TOKEN", "GITHUB_TOKEN"].includes(text(account["tokenSource"]) ?? "");
      const token = text(
        await runCommand(["gh", "auth", "token", "--hostname", "github.com", ...(fromEnv ? [] : ["--user", login])], 2000),
      );
      return token ? { token, login, editor: false } : null;
    }),
  );
  return tokens.filter((t): t is GitHubToken => t !== null);
}

function copilotWindow(value: unknown, scope: string, resetsAt: string | null) {
  const quota = record(value);
  const entitlement = number(quota["entitlement"]);
  const left = number(quota["percent_remaining"]);
  if (quota["unlimited"] === true || entitlement === null || entitlement <= 0 || left === null) return null;
  return { kind: "month", scope, used_percent: percent(100 - left), resets_at: resetsAt };
}

async function fetchCopilotProviders(timeoutMs: number, skipSubprocess: boolean): Promise<GenericProvider[]> {
  const home = homedir();
  const dir = join(process.env["XDG_CONFIG_HOME"] || join(home, ".config"), "github-copilot");
  const tokens = [
    ...copilotFileTokens(readText(join(dir, "apps.json"))),
    ...copilotFileTokens(readText(join(dir, "hosts.json"))),
    ...(await ghTokens(skipSubprocess)),
  ];
  if (tokens.length === 0) return [];

  const editorAccounts = tokens.flatMap(({ login, editor }) => (editor && login ? [login.toLowerCase()] : []));
  const accounts = new Map<string, { login: string | null; tokens: string[]; editor: boolean }>();
  const seen = new Set<string>();
  let unknown = 0;
  for (const { token, login, editor } of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const id = login?.toLowerCase() ?? `#${++unknown}`;
    const acc = accounts.get(id) ?? { login, tokens: [], editor: false };
    acc.tokens.push(token);
    acc.editor ||= editor;
    accounts.set(id, acc);
  }

  const results: GenericProvider[] = [];
  for (const [, { login, tokens: accountTokens, editor }] of accounts) {
    let body: Json | null = null;
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
            "x-github-api-version": "2025-04-01",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 404) continue;
        if (res.status === 401 || res.status === 403) {
          expired = true;
          continue;
        }
        if (!res.ok) break;
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
      copilotWindow(snapshots["completions"], "Completions", resetsAt),
    ].filter((w): w is NonNullable<typeof w> => w !== null);

    const left = record(body["limited_user_quotas"]);
    const monthly = record(body["monthly_quotas"]);
    for (const [key, scope] of [
      ["chat", "Chat"],
      ["completions", "Completions"],
    ] as const) {
      const total = number(monthly[key]);
      const remaining = number(left[key]);
      if (total && total > 0 && remaining !== null && !windows.some((w) => w.scope === scope)) {
        windows.push({
          kind: "month",
          scope,
          used_percent: percent(((total - remaining) / total) * 100),
          resets_at: isoTime(body["limited_user_reset_date"]) ?? resetsAt,
        });
      }
    }

    const plan = text(body["access_type_sku"])?.includes("free") ? "free" : text(body["copilot_plan"]);
    const resolvedLogin = text(body["login"]) ?? login;
    const isEditorAccount = resolvedLogin !== null && editorAccounts.includes(resolvedLogin.toLowerCase());
    if (plan === "free" && !editor && !isEditorAccount) continue;

    results.push({
      id: "copilot",
      account: resolvedLogin ?? "",
      plan,
      windows,
      problem: null,
    });
  }
  return results;
}

const GROK_PERIOD_KINDS: Record<string, string> = {
  USAGE_PERIOD_TYPE_DAILY: "day",
  USAGE_PERIOD_TYPE_WEEKLY: "week",
  USAGE_PERIOD_TYPE_MONTHLY: "month",
};

async function fetchGrokProviders(timeoutMs: number): Promise<GenericProvider[]> {
  const home = homedir();
  const entries = Object.entries(record(parseJson(readText(join(home, ".grok", "auth.json")))));
  if (entries.length === 0) return [];

  const results: GenericProvider[] = [];
  for (const [, raw] of entries) {
    const val = record(raw);
    const token = text(val["key"]);
    if (!token) continue;
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
          "user-agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) {
        results.push({ id: "grok", account: email, plan: null, windows: [], problem: "expired" });
        continue;
      }
      if (!res.ok) continue;
      const body = record(await res.json());
      const config = record(body["config"]);
      const period = record(config["currentPeriod"]);
      const stated = number(config["creditUsagePercent"]);
      const knownKind = GROK_PERIOD_KINDS[text(period["type"]) ?? ""];
      if (stated === null && knownKind === undefined) continue;
      const start = epochMs(period["start"]);
      const end = epochMs(period["end"]);
      const kind = knownKind ?? kindOf(start !== null && end !== null ? (end - start) / 1000 : null, "month");
      results.push({
        id: "grok",
        account: email,
        plan: null,
        windows: [{ kind, scope: null, used_percent: percent(stated ?? 0), resets_at: isoTime(period["end"]) }],
        problem: null,
      });
    } catch {}
  }
  return results;
}

async function fetchOpencodeProviders(timeoutMs: number): Promise<GenericProvider[]> {
  const home = homedir();
  const dir = join(process.env["XDG_DATA_HOME"] || join(home, ".local", "share"), "opencode");
  const root = record(parseJson(readText(join(dir, "auth.json"))));
  let token: string | null = null;
  for (const provider of ["opencode-go", "opencode"]) {
    const entry = record(root[provider]);
    if (entry["type"] === "api") {
      token = text(entry["key"]);
      if (token) break;
    }
  }
  if (!token) token = text(process.env["OPENCODE_API_KEY"]);
  if (!token) return [];

  try {
    const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 403 || !res.ok) return [];
    const body = record(await res.json());
    const usage = record(body["usage"]);
    const windows: GenericProvider["windows"] = [];
    for (const [key, kind] of [
      ["rolling", "session"],
      ["weekly", "week"],
      ["monthly", "month"],
    ] as const) {
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

export async function fetchOtherProviders(options?: { fast?: boolean }): Promise<GenericProvider[]> {
  const fast = options?.fast === true;
  const timeoutMs = fast ? 1200 : 3500;
  const [cursor, copilot, grok, opencode] = await Promise.all([
    fetchCursorProviders(timeoutMs),
    fetchCopilotProviders(timeoutMs, fast),
    fetchGrokProviders(timeoutMs),
    fetchOpencodeProviders(timeoutMs),
  ]);
  return [...cursor, ...copilot, ...grok, ...opencode];
}
