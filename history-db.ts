import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function historyFile(): string {
  if (process.env.HERDR_USAGE_HISTORY_FILE) return process.env.HERDR_USAGE_HISTORY_FILE;
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "herdr-usage-monitor", "history.sqlite");
}

export function openHistoryDatabase(file: string, readonly = false): Database {
  if (!readonly) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, "a", 0o600));
  }
  const db = new Database(file, readonly ? { readonly: true } : { readwrite: true });
  try {
    db.run("PRAGMA busy_timeout = 2000");
    if (!readonly && db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version === 0) {
      db.transaction(() => db.exec(`
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
          PRIMARY KEY (provider, event_id)
        );
        CREATE INDEX IF NOT EXISTS model_usage_time ON model_usage (observed_at);
        CREATE INDEX IF NOT EXISTS model_usage_model ON model_usage (provider, model, effort, observed_at);

        CREATE TABLE IF NOT EXISTS model_log_offsets (
          log_id TEXT PRIMARY KEY NOT NULL,
          byte_offset INTEGER NOT NULL,
          modified_at REAL NOT NULL
        );
        PRAGMA user_version = 1;
      `)).immediate();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
