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

test("collects antigravity model and thinking effort from brain transcripts", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-usage-agy-"));
  try {
    const file = join(root, "history.sqlite");
    const brain = join(root, "brain");
    const convA = join(brain, "conv-a", ".system_generated", "logs");
    const convB = join(brain, "conv-b", ".system_generated", "logs");
    mkdirSync(convA, { recursive: true });
    mkdirSync(convB, { recursive: true });
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const logA = join(convA, "transcript.jsonl");
    const fullLogA = join(convA, "transcript_full.jsonl");
    const logB = join(convB, "transcript.jsonl");

    const step1 = { step_index: 1, type: "PLANNER_RESPONSE", created_at: createdAt, model: "gemini-4-neon-medium" };
    const step2 = { step_index: 2, type: "PLANNER_RESPONSE", created_at: createdAt, model: "gemini-flash-worker-agy" };
    const ignored = { step_index: 3, type: "USER_INPUT", created_at: createdAt, model: "gemini-4-neon-high" };
    writeFileSync(logA, `${[step1, step2, ignored].map((e) => JSON.stringify(e)).join("\n")}\n`);
    writeFileSync(fullLogA, `${JSON.stringify({ step_index: 99, type: "PLANNER_RESPONSE", created_at: createdAt, model: "gemini-4-neon-xhigh" })}\n`);
    // Same step_index in a second conversation should not collide with conv-a.
    writeFileSync(logB, `${JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: createdAt, model: "gemini-4-hydrogen-xhigh" })}\n`);

    await syncModelUsage(file, [{ provider: "antigravity", path: brain }], now);
    await syncModelUsage(file, [{ provider: "antigravity", path: brain }], now);

    const db = openHistoryDatabase(file, true);
    try {
      const rows = db.query("SELECT provider, observed_at, model, effort FROM model_usage ORDER BY model, effort").all();
      expect(rows).toEqual([
        { provider: "antigravity", observed_at: now, model: "gemini-4-hydrogen", effort: "xhigh" },
        { provider: "antigravity", observed_at: now, model: "gemini-4-neon", effort: "medium" },
        { provider: "antigravity", observed_at: now, model: "gemini-flash-worker-agy", effort: null },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
