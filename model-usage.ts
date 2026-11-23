import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { historyFile, openHistoryDatabase } from "./history-db.ts";

const LOG_LOOKBACK_MS = 8 * 24 * 60 * 60_000;

type Provider = "claude" | "codex" | "antigravity";
type LogRoot = { provider: Provider; path: string };
type LogOffset = { byte_offset: number; modified_at: number };
type ModelUse = { id: string; at: number; model: string; effort: string | null };
type ModelActivity = Omit<ModelUse, "id"> & { provider: Provider };

function localLogs(): LogRoot[] {
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
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
const label = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._:@/+\-]{0,199}$/i.test(value) ? value : null;
const EFFORT_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max)$/i;

function splitModelEffort(raw: string): { model: string; effort: string | null } {
  const match = EFFORT_SUFFIX.exec(raw);
  return match ? { model: match[1]!, effort: match[2]!.toLowerCase() } : { model: raw, effort: null };
}

function usageFromLine(line: string, provider: Provider, cutoff: number, logId = ""): ModelUse | undefined {
  // Most lines are message bodies or tool results. Only decode the event types we use.
  const type = provider === "codex"
    ? /"type"\s*:\s*"turn_context"/
    : provider === "claude"
      ? /"type"\s*:\s*"assistant"/
      : /"type"\s*:\s*"PLANNER_RESPONSE"/;
  if (!type.test(line)) return;
  let event: Record<string, unknown> | undefined;
  try {
    event = object(JSON.parse(line));
  } catch {
    return;
  }
  const rawAt = provider === "antigravity" ? (event?.created_at ?? event?.timestamp) : event?.timestamp;
  const at = typeof rawAt === "string" ? Date.parse(rawAt) : NaN;
  if (!Number.isFinite(at) || at < cutoff) return;

  if (provider === "codex" && event?.type === "turn_context") {
    const turn = object(event.payload);
    const id = label(turn?.turn_id);
    const model = label(turn?.model);
    if (id && model) return { id: hash(id), at, model, effort: label(turn?.effort) };
  }
  if (provider === "claude" && event?.type === "assistant") {
    const message = object(event.message);
    const id = label(message?.id);
    const model = label(message?.model);
    if (id && model) {
      return { id: hash(id), at, model, effort: label(event.perTurnEffort) ?? label(event.effort) };
    }
  }
  if (provider === "antigravity" && event?.type === "PLANNER_RESPONSE") {
    const rawModel = label(event.model);
    const step = typeof event.step_index === "number" && Number.isFinite(event.step_index)
      ? String(event.step_index)
      : label(event.step_index);
    if (rawModel && step !== null) {
      const parsed = splitModelEffort(rawModel);
      const explicitEffort = label(event.effort) ?? label(event.thinking_level);
      return { id: hash(`${logId}:${step}`), at, model: parsed.model, effort: explicitEffort ?? parsed.effort };
    }
  }
}

async function readLog(path: string, start: number, end: number, provider: Provider, cutoff: number, logId: string) {
  const usage: ModelUse[] = [];
  let offset = start;
  let pending = Buffer.alloc(0);
  for await (const chunk of Bun.file(path).slice(start, end).stream()) {
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    let lineStart = 0;
    for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, lineStart)) {
      const entry = usageFromLine(bytes.toString("utf8", lineStart, newline), provider, cutoff, logId);
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

/** Collect recent session metadata independently of provider allowance snapshots. */
export async function syncModelUsage(file = historyFile(), roots = localLogs(), now = Date.now()): Promise<void> {
  const cutoff = now - LOG_LOOKBACK_MS;
  const db = openHistoryDatabase(file);
  try {
    const lookup = db.query<LogOffset, [string]>("SELECT byte_offset, modified_at FROM model_log_offsets WHERE log_id = ?");
    const insert = db.query(`
      INSERT INTO model_usage (provider, event_id, observed_at, model, effort) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (provider, event_id) DO UPDATE SET
        observed_at = min(model_usage.observed_at, excluded.observed_at),
        effort = coalesce(model_usage.effort, excluded.effort)
      WHERE excluded.observed_at < model_usage.observed_at
         OR (model_usage.effort IS NULL AND excluded.effort IS NOT NULL)
    `);
    const save = db.query(`
      INSERT INTO model_log_offsets (log_id, byte_offset, modified_at) VALUES (?, ?, ?)
      ON CONFLICT (log_id) DO UPDATE SET byte_offset = excluded.byte_offset, modified_at = excluded.modified_at
      WHERE excluded.modified_at > model_log_offsets.modified_at
         OR (excluded.modified_at = model_log_offsets.modified_at AND excluded.byte_offset > model_log_offsets.byte_offset)
    `);
    const commit = db.transaction((provider: Provider, id: string, modifiedAt: number, delta: Awaited<ReturnType<typeof readLog>>) => {
      for (const row of delta.usage) insert.run(provider, row.id, row.at, row.model, row.effort);
      save.run(id, delta.offset, modifiedAt);
    });

    for (const root of roots) {
      const { provider } = root;
      for (const log of await logFiles(root)) {
        try {
          const info = await stat(log);
          if (!info.isFile() || info.mtimeMs < cutoff) continue;
          const id = hash(`${provider}:${log}:${info.dev}:${info.ino}:${info.birthtimeMs}`);
          const previous = lookup.get(id);
          if (previous?.byte_offset === info.size && previous.modified_at === info.mtimeMs) continue;
          const start = previous && previous.byte_offset < info.size ? previous.byte_offset : 0;
          if (start === info.size) continue;
          const delta = await readLog(log, start, info.size, provider, cutoff, id);
          if (delta.offset > start) commit.immediate(provider, id, info.mtimeMs, delta);
        } catch (error) {
          if (!unavailable(error)) throw error;
        }
      }
    }
    db.query("DELETE FROM model_log_offsets WHERE modified_at < ?").run(cutoff);
  } finally {
    db.close();
  }
}
