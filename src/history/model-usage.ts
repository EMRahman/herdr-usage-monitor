import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { historyFile, openHistoryDatabase } from "./db.ts";

export const PARSER_VERSION = 2;
const DEFAULT_SYNC_BUDGET_MS = 3_000;
const CODEX_TWIN_WINDOW_MS = 5 * 60_000;
const MAX_CODEX_TURNS = 64;
const MAX_CODEX_RESPONSE_KEYS = 64;

export type Provider = "claude" | "codex" | "antigravity";
export type LogRoot = { provider: Provider; path: string };

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface SyncOptions {
  /** Soft wall-clock budget per sync call so large backfills never stall the UI. */
  budgetMs?: number;
  /** Optional lookback cap in ms; null/undefined collects all available history. */
  maxLookbackMs?: number | null;
}

export interface SyncStats {
  pendingFiles: number;
  processedFiles: number;
  totalFiles: number;
  scannedBytes: number;
}

type LogOffset = {
  byte_offset: number;
  modified_at: number;
  file_size: number | null;
  parser_version: number;
  state_json: string | null;
};

type ModelUse = {
  id: string;
  at: number;
  model: string;
  effort: string | null;
  modelProvider: string | null;
  sessionId: string | null;
  sourceKind: "usage" | "turn";
  tokens: TokenCounts | null;
};

export type ModelActivity = {
  provider: Provider;
  at: number;
  model: string;
  effort: string | null;
};

type TokenVec = [number, number, number, number, number];

interface CodexRawTotals {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

interface CodexTurnMeta {
  model: string;
  effort: string | null;
}

interface CodexTwin {
  key: string;
  vec: TokenVec;
  at: number;
  cumulative: TokenVec | null;
  responseId: string;
  turnId: string;
}

interface CodexFileState {
  sessionHash?: string;
  modelProvider?: string;
  model?: string;
  effort?: string | null;
  fallbackAt?: number;
  forkReplay?: boolean;
  forkStartMs?: number;
  turns?: Record<string, CodexTurnMeta>;
  legacyTotals?: CodexRawTotals;
  modernPending?: TokenCounts;
  modernRecent?: CodexTwin[];
  pendingTwin?: CodexTwin | null;
  responseKeys?: Record<string, string>;
}

export function localLogs(): LogRoot[] {
  const codex = process.env.CODEX_HOME || join(homedir(), ".codex");
  const claude = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const antigravity = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), ".gemini", "antigravity-cli");
  const roots: LogRoot[] = [
    { provider: "codex", path: join(codex, "sessions") },
    { provider: "codex", path: join(codex, "archived_sessions") },
    { provider: "claude", path: join(claude, "projects") },
    { provider: "antigravity", path: join(antigravity, "brain") },
  ];
  if (!process.env.ANTIGRAVITY_APP_DATA_DIR) {
    roots.push({ provider: "antigravity", path: join(homedir(), ".gemini", "antigravity", "brain") });
  }
  return roots;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const shortHash = (value: string) => hash(value).slice(0, 16);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const label = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._:@/+\-]{0,199}$/i.test(value) ? value : null;
const nonEmptyString = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : "";
const toNonNegInt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const hasFiniteTokenField = (obj: Record<string, unknown> | undefined, keys: string[]): boolean =>
  Boolean(obj && keys.some((key) => typeof obj[key] === "number" && Number.isFinite(obj[key])));

const EFFORT_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max)$/i;

function splitModelEffort(raw: string): { model: string; effort: string | null } {
  const match = EFFORT_SUFFIX.exec(raw);
  return match ? { model: match[1]!, effort: match[2]!.toLowerCase() } : { model: raw, effort: null };
}

function inferModelProvider(model: string, fallback: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("claude")) return "anthropic";
  if (lower.startsWith("gpt") || /^o[1-9]\b|^o[1-9]-/.test(lower) || lower.includes("codex")) return "openai";
  if (lower.includes("gemini")) return "google";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("grok")) return "xai";
  return fallback;
}

function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function hasAnyTokens(tokens: TokenCounts): boolean {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0;
}

function tokenVec(tokens: TokenCounts): TokenVec {
  return [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.reasoning];
}

function sameVec(left: TokenVec | null | undefined, right: TokenVec | null | undefined): boolean {
  return Boolean(left && right && left.length === right.length && left.every((value, i) => value === right[i]));
}

function addTokens(target: TokenCounts, delta: TokenCounts): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.reasoning += delta.reasoning;
}

function subtractTokens(tokens: TokenCounts, alreadyCounted: TokenCounts): TokenCounts {
  return {
    input: Math.max(0, tokens.input - alreadyCounted.input),
    output: Math.max(0, tokens.output - alreadyCounted.output),
    cacheRead: Math.max(0, tokens.cacheRead - alreadyCounted.cacheRead),
    cacheWrite: Math.max(0, tokens.cacheWrite - alreadyCounted.cacheWrite),
    reasoning: Math.max(0, tokens.reasoning - alreadyCounted.reasoning),
  };
}

function trimMap<T>(record: Record<string, T>, maxKeys: number): void {
  const keys = Object.keys(record);
  if (keys.length <= maxKeys) return;
  for (const key of keys.slice(0, keys.length - maxKeys)) delete record[key];
}

// ---- Claude Code ----

function claudeCacheWrite(usage: Record<string, unknown>): number {
  if (typeof usage.cache_creation_input_tokens === "number" && Number.isFinite(usage.cache_creation_input_tokens)) {
    return toNonNegInt(usage.cache_creation_input_tokens);
  }
  const nested = object(usage.cache_creation);
  if (!nested) return 0;
  let sum = 0;
  for (const value of Object.values(nested)) sum += toNonNegInt(value);
  return sum;
}

function parseClaudeLine(line: string, cutoff: number, logId: string): ModelUse | undefined {
  if (!/"type"\s*:\s*"assistant"/.test(line)) return;
  let event: Record<string, unknown> | undefined;
  try {
    event = object(JSON.parse(line));
  } catch {
    return;
  }
  if (event?.type !== "assistant") return;
  const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  if (!Number.isFinite(at) || at < cutoff) return;

  const message = object(event.message);
  const id = label(message?.id);
  const model = label(message?.model);
  if (!id || !model) return;

  const effort = label(event.perTurnEffort) ?? label(event.effort);
  const rawSession = nonEmptyString(event.sessionId ?? event.session_id) || logId;
  const sessionId = shortHash(`claude:${rawSession}`);
  const modelProvider = label(message?.provider) ?? inferModelProvider(model, "anthropic");

  const usage = object(message?.usage);
  const hasUsage = hasFiniteTokenField(usage, [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]) || Boolean(object(usage?.cache_creation));

  const tokens: TokenCounts | null = hasUsage && usage
    ? {
        input: toNonNegInt(usage.input_tokens),
        output: toNonNegInt(usage.output_tokens),
        cacheRead: toNonNegInt(usage.cache_read_input_tokens),
        cacheWrite: claudeCacheWrite(usage),
        reasoning: toNonNegInt(object(usage.output_tokens_details)?.thinking_tokens),
      }
    : null;

  return {
    id: hash(id),
    at,
    model,
    effort,
    modelProvider,
    sessionId,
    sourceKind: tokens ? "usage" : "turn",
    tokens,
  };
}

// ---- Antigravity ----

function antigravityConversationId(filePath: string, logId: string): string {
  // .../brain/<conv-id>/.system_generated/logs/transcript.jsonl
  const logsDir = dirname(filePath);
  const sysDir = dirname(logsDir);
  if (basename(logsDir) === "logs" && basename(sysDir) === ".system_generated") {
    const conv = basename(dirname(sysDir));
    if (conv) return conv;
  }
  return logId;
}

function parseAntigravityLine(line: string, cutoff: number, logId: string, convId: string): ModelUse | undefined {
  if (!/"type"\s*:\s*"PLANNER_RESPONSE"/.test(line)) return;
  let event: Record<string, unknown> | undefined;
  try {
    event = object(JSON.parse(line));
  } catch {
    return;
  }
  if (event?.type !== "PLANNER_RESPONSE") return;
  const rawAt = event.created_at ?? event.timestamp;
  const at = typeof rawAt === "string" ? Date.parse(rawAt) : NaN;
  if (!Number.isFinite(at) || at < cutoff) return;

  const rawModel = label(event.model);
  const step = typeof event.step_index === "number" && Number.isFinite(event.step_index)
    ? String(event.step_index)
    : label(event.step_index);
  if (!rawModel || step === null) return;

  const parsed = splitModelEffort(rawModel);
  const explicitEffort = label(event.effort) ?? label(event.thinking_level);
  const modelProvider = label(event.provider) ?? inferModelProvider(parsed.model, "google");
  const sessionId = shortHash(`antigravity:${convId}`);

  const hasUsage = hasFiniteTokenField(event, [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
  ]);
  const tokens: TokenCounts | null = hasUsage
    ? {
        // Antigravity transcript input_tokens is already uncached.
        input: toNonNegInt(event.input_tokens),
        output: toNonNegInt(event.output_tokens),
        cacheRead: toNonNegInt(event.cache_read_tokens),
        cacheWrite: toNonNegInt(event.cache_write_tokens),
        reasoning: toNonNegInt(event.reasoning_tokens),
      }
    : null;

  return {
    id: hash(`${logId}:${step}`),
    at,
    model: parsed.model,
    effort: explicitEffort ?? parsed.effort,
    modelProvider,
    sessionId,
    sourceKind: tokens ? "usage" : "turn",
    tokens,
  };
}

// ---- OpenAI Codex ----

function codexUuidV7Ms(id: string): number | null {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(id);
  return match ? Number.parseInt(match[1]! + match[2]!, 16) : null;
}

function codexNormalized(raw: Record<string, unknown>): TokenCounts {
  // Codex raw input_tokens includes cached_input_tokens and cache_write_input_tokens.
  const inputRaw = toNonNegInt(raw.input_tokens);
  const cacheRead = toNonNegInt(raw.cached_input_tokens);
  const cacheWrite = toNonNegInt(raw.cache_write_input_tokens);
  return {
    input: Math.max(0, inputRaw - cacheRead - cacheWrite),
    output: toNonNegInt(raw.output_tokens),
    cacheRead,
    cacheWrite,
    reasoning: toNonNegInt(raw.reasoning_output_tokens),
  };
}

function codexRawTotals(raw: Record<string, unknown>): CodexRawTotals {
  return {
    input_tokens: toNonNegInt(raw.input_tokens),
    cached_input_tokens: toNonNegInt(raw.cached_input_tokens),
    cache_write_input_tokens: toNonNegInt(raw.cache_write_input_tokens),
    output_tokens: toNonNegInt(raw.output_tokens),
    reasoning_output_tokens: toNonNegInt(raw.reasoning_output_tokens),
  };
}

function codexCloseInTime(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return true;
  return Math.abs(left - right) <= CODEX_TWIN_WINDOW_MS;
}

function codexRememberModern(state: CodexFileState, twin: CodexTwin): void {
  state.modernRecent ??= [];
  state.modernRecent.push(twin);
  if (state.modernRecent.length > 8) state.modernRecent.shift();
}

function codexTakeModernTwin(
  state: CodexFileState,
  vec: TokenVec,
  at: number,
  cumulative: TokenVec | null,
  responseId: string,
  turnId: string,
): string | null {
  const recent = state.modernRecent;
  if (!recent?.length) return null;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const candidate = recent[i]!;
    const cumulativeOk = !candidate.cumulative || !cumulative || sameVec(candidate.cumulative, cumulative);
    if (
      sameVec(candidate.vec, vec)
      && codexCloseInTime(candidate.at, at)
      && cumulativeOk
      && (!responseId || !candidate.responseId || responseId === candidate.responseId)
      && (!turnId || !candidate.turnId || turnId === candidate.turnId)
    ) {
      recent.splice(i, 1);
      return candidate.key;
    }
  }
  return null;
}

function codexMatchesPendingTwin(
  pending: CodexTwin | null | undefined,
  vec: TokenVec,
  at: number,
  cumulative: TokenVec | null,
  responseId: string,
  turnId: string,
): string | null {
  if (!pending) return null;
  if (!sameVec(pending.vec, vec) || !codexCloseInTime(pending.at, at)) return null;
  if (responseId && pending.responseId && responseId !== pending.responseId) return null;
  if (pending.cumulative && cumulative && !sameVec(pending.cumulative, cumulative)) return null;
  if (turnId && pending.turnId && turnId !== pending.turnId) return null;
  return pending.key;
}

function parseCodexLine(
  line: string,
  cutoff: number,
  logId: string,
  state: CodexFileState,
): ModelUse | undefined {
  if (!/"type"\s*:\s*"(session_meta|turn_context|token_usage_record|event_msg)"/.test(line)) return;
  if (/"type"\s*:\s*"event_msg"/.test(line) && !/"type"\s*:\s*"(token_count|task_started)"/.test(line)) return;

  let event: Record<string, unknown> | undefined;
  try {
    event = object(JSON.parse(line));
  } catch {
    return;
  }
  if (!event) return;
  const payload = object(event.payload) ?? {};
  const rawAt = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  const at = Number.isFinite(rawAt) ? rawAt : (state.fallbackAt ?? NaN);

  // Fork replay ends once we observe a turn with a UUIDv7 timestamp strictly newer than the child thread's creation.
  if (
    state.forkReplay
    && typeof state.forkStartMs === "number"
    && (event.type === "turn_context" || (event.type === "event_msg" && payload.type === "task_started"))
  ) {
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
      if (Number.isFinite(headerAt)) state.fallbackAt = headerAt;
    }
    return;
  }

  if (event.type === "turn_context") {
    const turnId = label(payload.turn_id) ?? label(payload.root_turn_id);
    const model = label(payload.model);
    const effort = label(payload.effort);
    if (model) state.model = model;
    if (effort !== null || model) state.effort = effort;
    if (turnId && (model || state.model)) {
      state.turns ??= {};
      state.turns[turnId] = { model: model ?? state.model!, effort: effort ?? state.effort ?? null };
      trimMap(state.turns, MAX_CODEX_TURNS);
    }
    if (state.forkReplay || !Number.isFinite(at) || at < cutoff) return;
    if (turnId && model) {
      return {
        id: hash(turnId),
        at,
        model,
        effort,
        modelProvider: state.modelProvider ?? inferModelProvider(model, "openai"),
        sessionId: state.sessionHash ?? shortHash(`codex:${logId}`),
        sourceKind: "turn",
        tokens: null,
      };
    }
    return;
  }

  const sessionHash = (() => {
    const tid = nonEmptyString(payload.thread_id ?? payload.session_id ?? payload.threadId ?? payload.sessionId);
    return tid ? shortHash(`codex:${tid}`) : (state.sessionHash ?? shortHash(`codex:${logId}`));
  })();

  if (event.type === "token_usage_record") {
    const threadRaw = object(payload.thread_token_usage);
    if (state.forkReplay && threadRaw) {
      state.legacyTotals = codexRawTotals(threadRaw);
      state.modernPending = zeroTokens();
    }
    const usage = object(payload.usage);
    if (!usage) return;
    const tokens = codexNormalized(usage);
    if (!hasAnyTokens(tokens)) return;

    const turnId = nonEmptyString(payload.turn_id ?? payload.root_turn_id);
    const responseId = nonEmptyString(payload.response_id);
    const cumulativeRaw = threadRaw ?? object(payload.turn_token_usage);
    const cumulative = cumulativeRaw ? tokenVec(codexNormalized(cumulativeRaw)) : null;
    const vec = tokenVec(tokens);

    let dedupKey = responseId
      ? hash(`codex:resp:${responseId}`)
      : hash(`codex:turn:${sessionHash}:${turnId}:${String(event.timestamp ?? "")}:${vec.join(",")}`);

    const twinKey = codexMatchesPendingTwin(state.pendingTwin, vec, at, cumulative, responseId, turnId);
    if (responseId && state.responseKeys?.[responseId]) {
      dedupKey = state.responseKeys[responseId]!;
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

    if (!Number.isFinite(at) || at < cutoff) return;
    const ctx = (turnId && state.turns?.[turnId]) || { model: state.model ?? "unknown", effort: state.effort ?? null };
    return {
      id: dedupKey,
      at,
      model: ctx.model,
      effort: ctx.effort,
      modelProvider: state.modelProvider ?? inferModelProvider(ctx.model, "openai"),
      sessionId: sessionHash,
      sourceKind: "usage",
      tokens,
    };
  }

  if (event.type === "event_msg" && payload.type === "token_count") {
    const info = object(payload.info);
    if (!info) return;
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
        const twin: CodexTwin = {
          key,
          vec: tokenVec(lastTokens),
          at,
          cumulative: tokenVec(codexNormalized(totalsRaw)),
          responseId,
          turnId,
        };
        codexRememberModern(state, twin);
        state.pendingTwin = twin;
      }
      return;
    }

    state.pendingTwin = null;
    let deltaRaw: Record<string, unknown>;
    let keySeed: string;
    let reset = false;

    if (totalsRaw) {
      const current = codexRawTotals(totalsRaw);
      const prev = state.legacyTotals;
      const fields: Array<keyof CodexRawTotals> = [
        "input_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
      ];
      reset = Boolean(prev && fields.some((field) => current[field] < prev[field]));
      const delta: Record<string, number> = {};
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
    if (!hasAnyTokens(tokens)) return;

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

    if (!Number.isFinite(at) || at < cutoff) return;
    const ctx = (turnId && state.turns?.[turnId]) || { model: state.model ?? "unknown", effort: state.effort ?? null };
    return {
      id: dedupKey,
      at,
      model: ctx.model,
      effort: ctx.effort,
      modelProvider: state.modelProvider ?? inferModelProvider(ctx.model, "openai"),
      sessionId: sessionHash,
      sourceKind: "usage",
      tokens,
    };
  }
}

// ---- Streaming reader ----

async function readLog(
  path: string,
  start: number,
  end: number,
  provider: Provider,
  cutoff: number,
  logId: string,
  codexState: CodexFileState,
) {
  const usage: ModelUse[] = [];
  let offset = start;
  let pending = Buffer.alloc(0);
  const convId = provider === "antigravity" ? antigravityConversationId(path, logId) : "";

  for await (const chunk of Bun.file(path).slice(start, end).stream()) {
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    let lineStart = 0;
    for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, lineStart)) {
      const line = bytes.toString("utf8", lineStart, newline);
      const entry = provider === "codex"
        ? parseCodexLine(line, cutoff, logId, codexState)
        : provider === "claude"
          ? parseClaudeLine(line, cutoff, logId)
          : parseAntigravityLine(line, cutoff, logId, convId);
      if (entry) usage.push(entry);
      lineStart = newline + 1;
    }
    offset += lineStart;
    pending = bytes.subarray(lineStart);
  }
  // An active session can be halfway through writing a line. Retry it on the next poll.
  return { usage, offset };
}

function unavailable(error: unknown): boolean {
  return ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

async function logFiles({ provider, path }: LogRoot): Promise<string[]> {
  const root = resolve(path);
  const entries = await readdir(root, { recursive: provider !== "antigravity", withFileTypes: true }).catch((error) => {
    if (!unavailable(error)) throw error;
    return [];
  });
  if (provider === "antigravity") {
    const logs: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "transcript.jsonl") logs.push(join(entry.parentPath, entry.name));
      else if (entry.isDirectory()) logs.push(join(entry.parentPath, entry.name, ".system_generated", "logs", "transcript.jsonl"));
    }
    return logs;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name));
}

export function readModelUsage(from: number, through: number, file = historyFile()): ModelActivity[] {
  if (from > through || !existsSync(file)) return [];
  const db = openHistoryDatabase(file, true);
  try {
    if (!db.query("SELECT 1 FROM sqlite_schema WHERE name = 'model_usage'").get()) return [];
    return db.query<ModelActivity, [number, number]>(`
      SELECT provider, observed_at AS at, model, effort FROM model_usage
      WHERE observed_at BETWEEN ? AND ? ORDER BY observed_at
    `).all(from, through);
  } finally {
    db.close();
  }
}

/** The latest observed activity timestamp for each provider in history.sqlite. */
export function latestModelActivity(file = historyFile()): Record<string, number> {
  if (!existsSync(file)) return {};
  try {
    const db = openHistoryDatabase(file, true);
    try {
      if (!db.query("SELECT 1 FROM sqlite_schema WHERE name = 'model_usage'").get()) return {};
      const rows = db.query<{ provider: string; latest_at: number }, []>(`
        SELECT provider, MAX(observed_at) AS latest_at FROM model_usage
        GROUP BY provider
      `).all();
      const result: Record<string, number> = {};
      for (const row of rows) {
        if (row.provider && typeof row.latest_at === "number") {
          result[row.provider] = row.latest_at;
        }
      }
      return result;
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

interface CandidateLog {
  provider: Provider;
  path: string;
  id: string;
  size: number;
  mtimeMs: number;
  start: number;
  previous: LogOffset | null;
}

/** Collect session metadata & token counts incrementally, newest files first within a time budget. */
export async function syncModelUsage(
  file = historyFile(),
  roots = localLogs(),
  now = Date.now(),
  options: SyncOptions = {},
): Promise<SyncStats> {
  const cutoff = options.maxLookbackMs != null && Number.isFinite(options.maxLookbackMs)
    ? now - options.maxLookbackMs
    : 0;
  const budgetMs = options.budgetMs ?? DEFAULT_SYNC_BUDGET_MS;
  const deadline = Number.isFinite(budgetMs) && budgetMs > 0 ? Date.now() + budgetMs : Infinity;

  const db = openHistoryDatabase(file);
  try {
    const lookup = db.query<LogOffset, [string]>(
      "SELECT byte_offset, modified_at, file_size, parser_version, state_json FROM model_log_offsets WHERE log_id = ?",
    );
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
    const commit = db.transaction((
      provider: Provider,
      id: string,
      modifiedAt: number,
      fileSize: number,
      delta: Awaited<ReturnType<typeof readLog>>,
      stateJson: string | null,
    ) => {
      for (const row of delta.usage) {
        insert.run(
          provider,
          row.id,
          row.at,
          row.model,
          row.effort,
          row.modelProvider,
          row.sessionId,
          row.sourceKind,
          row.tokens ? row.tokens.input : null,
          row.tokens ? row.tokens.output : null,
          row.tokens ? row.tokens.cacheRead : null,
          row.tokens ? row.tokens.cacheWrite : null,
          row.tokens ? row.tokens.reasoning : null,
        );
      }
      save.run(id, delta.offset, modifiedAt, fileSize, PARSER_VERSION, stateJson);
    });

    const dirty: CandidateLog[] = [];
    let totalFiles = 0;

    for (const root of roots) {
      const { provider } = root;
      for (const log of await logFiles(root)) {
        try {
          const info = await stat(log);
          if (!info.isFile()) continue;
          if (cutoff > 0 && info.mtimeMs < cutoff) continue;
          totalFiles += 1;
          const id = hash(`${provider}:${log}:${info.dev}:${info.ino}:${info.birthtimeMs}`);
          const previous = lookup.get(id) ?? null;
          const upToDate = previous
            && previous.parser_version >= PARSER_VERSION
            && previous.byte_offset === info.size
            && previous.modified_at === info.mtimeMs
            && (previous.file_size == null || previous.file_size === info.size);
          if (upToDate) continue;

          const canResume = Boolean(
            previous
            && previous.parser_version >= PARSER_VERSION
            && previous.byte_offset > 0
            && previous.byte_offset < info.size
            && (previous.file_size == null || info.size >= previous.file_size),
          );
          const start = canResume ? previous!.byte_offset : 0;
          if (start === info.size && previous && previous.parser_version >= PARSER_VERSION) continue;
          dirty.push({ provider, path: log, id, size: info.size, mtimeMs: info.mtimeMs, start, previous });
        } catch (error) {
          if (!unavailable(error)) throw error;
        }
      }
    }

    // Prioritize newest files so recent horizons (D / W) populate first during a large backfill.
    dirty.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let processedFiles = 0;
    let scannedBytes = 0;

    for (const candidate of dirty) {
      if (processedFiles > 0 && Date.now() >= deadline) break;
      let codexState: CodexFileState = {};
      if (candidate.provider === "codex" && candidate.start > 0 && candidate.previous?.state_json) {
        try {
          codexState = JSON.parse(candidate.previous.state_json) as CodexFileState;
        } catch {
          codexState = {};
          candidate.start = 0;
        }
      }
      try {
        const delta = await readLog(
          candidate.path,
          candidate.start,
          candidate.size,
          candidate.provider,
          cutoff,
          candidate.id,
          codexState,
        );
        scannedBytes += Math.max(0, candidate.size - candidate.start);
        const stateJson = candidate.provider === "codex" && Object.keys(codexState).length > 0
          ? JSON.stringify(codexState)
          : null;
        const shouldCommit = delta.offset > candidate.start
          || (candidate.size === 0 && (candidate.previous?.parser_version ?? 0) < PARSER_VERSION);
        if (shouldCommit) {
          commit.immediate(candidate.provider, candidate.id, candidate.mtimeMs, candidate.size, delta, stateJson);
        }
        processedFiles += 1;
      } catch (error) {
        if (!unavailable(error)) throw error;
        processedFiles += 1;
      }
    }

    return {
      pendingFiles: Math.max(0, dirty.length - processedFiles),
      processedFiles,
      totalFiles,
      scannedBytes,
    };
  } finally {
    db.close();
  }
}
