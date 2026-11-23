import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryDatabase } from "./history-db.ts";
import { syncModelUsage } from "./model-usage.ts";

test("collects model and effort once and retries an incomplete log line", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-usage-"));
  try {
    const file = join(root, "history.sqlite");
    const codex = join(root, "codex");
    const claude = join(root, "claude");
    mkdirSync(codex);
    mkdirSync(claude);
    const roots = [{ provider: "codex", path: codex }, { provider: "claude", path: claude }] as const;
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const codexLog = join(codex, "session.jsonl");
    const claudeLog = join(claude, "session.jsonl");
    const response = {
      type: "assistant", timestamp, effort: "medium", perTurnEffort: "high",
      message: { id: "msg_123", model: "claude-opus-4-8", content: "private text" },
    };
    writeFileSync(claudeLog, [response, response, {
      ...response, message: { id: "msg_synthetic", model: "<synthetic>" },
    }, {
      ...response, timestamp: new Date(now - 9 * 24 * 60 * 60_000).toISOString(), message: { ...response.message, id: "msg_old" },
    }].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const context = JSON.stringify({
      type: "turn_context", timestamp,
      payload: { turn_id: "turn-123", model: "gpt-6.2-sol", effort: "xhigh", cwd: "/private/path" },
    });
    writeFileSync(codexLog, `malformed\n${context.slice(0, -2)}`);

    function reads() {
      const db = openHistoryDatabase(file, true);
      try {
        return db.query("SELECT provider, observed_at, model, effort FROM model_usage ORDER BY provider, rowid").all();
      } finally {
        db.close();
      }
    }

    await syncModelUsage(file, [...roots], now);
    const first = { provider: "claude", observed_at: now, model: "claude-opus-4-8", effort: "high" };
    expect(reads()).toEqual([first]);
    const noEffort = JSON.stringify({
      type: "turn_context", timestamp, payload: { turn_id: "turn-456", model: "gpt-6.2-sol" },
    });
    appendFileSync(codexLog, `${context.slice(-2)}\n${noEffort}\n`);
    await Promise.all([syncModelUsage(file, [...roots], now), syncModelUsage(file, [...roots], now)]);
    await syncModelUsage(file, [...roots], now);

    expect(reads()).toEqual([
      first,
      { provider: "codex", observed_at: now, model: "gpt-6.2-sol", effort: "xhigh" },
      { provider: "codex", observed_at: now, model: "gpt-6.2-sol", effort: null },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
