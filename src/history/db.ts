import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 2;

export function historyFile(): string {
  if (process.env.HERDR_USAGE_HISTORY_FILE) return process.env.HERDR_USAGE_HISTORY_FILE;
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "herdr-usage-monitor", "history.sqlite");
}

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}

function addColumnIfMissing(db: Database, table: string, existing: Set<string>, name: string, definition: string): void {
  if (existing.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  existing.add(name);
}

function createV2Schema(db: Database): void {
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

function migrateV1ToV2(db: Database): void {
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

const BUSY_TIMEOUT_MS = 2000;

const isBusy = (error: unknown) =>
  typeof (error as { code?: unknown })?.code === "string" && (error as { code: string }).code.startsWith("SQLITE_BUSY");

// Switching a new file to WAL needs an exclusive lock, and SQLite reports SQLITE_BUSY at once
// rather than waiting out busy_timeout, so two bridge processes opening a fresh history
// together would fail one of them. Retry within the same timeout; once any process has made
// the switch, the file stays in WAL and the check needs no lock.
function enableWal(db: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (let delay = 5; ; delay = Math.min(delay * 2, 50)) {
    try {
      const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode;
      if (mode === "wal") return;
      db.run("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
      Bun.sleepSync(delay);
    }
  }
}

const schemaVersion = (db: Database) =>
  db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;

export function openHistoryDatabase(file: string, readonly = false): Database {
  if (!readonly) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, "a", 0o600));
  }
  const db = new Database(file, readonly ? { readonly: true } : { readwrite: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!readonly) {
      enableWal(db);
      if (schemaVersion(db) < SCHEMA_VERSION) {
        // Another process may have created or migrated the schema since the check above.
        db.transaction(() => {
          const version = schemaVersion(db);
          if (version === 0) createV2Schema(db);
          else if (version === 1) migrateV1ToV2(db);
        }).immediate();
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
