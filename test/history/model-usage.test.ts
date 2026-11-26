import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryDatabase, SCHEMA_VERSION } from "../../src/history/db.ts";
import { PARSER_VERSION, readCodexPrompts, syncModelUsage } from "../../src/history/model-usage.ts";

test("resolves Codex chart prompts from the log and looks up tokens for the selected interval", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-prompts-"));
  try {
    const file = join(root, "history.sqlite");
    const log = join(root, "session.jsonl");
    const roots = [{ provider: "codex" as const, path: root }];
    const start = Date.now() - 60_000;
    const event = (seconds: number, type: string, payload: object) => JSON.stringify({
      type, payload, timestamp: new Date(start + seconds * 1_000).toISOString(),
    });
    const user = (seconds: number, text: string, kind: string) => event(seconds, "response_item", {
      type: "message",
      role: "user",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-1", content_item_kinds: [kind] },
      content: [{ type: "input_text", text }],
    });
    writeFileSync(log, [
      event(0, "session_meta", { id: "session-1" }),
      event(1, "event_msg", { type: "task_started", turn_id: "turn-1" }),
      event(2, "turn_context", { turn_id: "turn-1", model: "gpt-6.2-sol" }),
      user(3, "Injected context", "agents_md.instructions"),
      user(4, "Review the patch", "user.text"),
      event(5, "event_msg", { type: "user_message", message: "Review the patch" }),
      event(6, "token_usage_record", {
        turn_id: "child-turn", root_turn_id: "turn-1", response_id: "response-1",
        usage: { input_tokens: 20, cached_input_tokens: 12, output_tokens: 3 },
      }),
      event(7, "event_msg", { type: "user_message", message: "Focus on the tests" }),
      event(8, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 4, output_tokens: 1 } } }),
      event(9, "event_msg", { type: "task_complete", turn_id: "turn-1" }),
      event(10, "event_msg", { type: "task_started", turn_id: "turn-2" }),
      event(11, "event_msg", { type: "user_message", message: "A prompt with no tokens yet" }),
      "",
    ].join("\n"));
    await syncModelUsage(file, roots);
    expect(Bun.file(file).size).toBeGreaterThan(0);
    expect(Buffer.from(await Bun.file(file).arrayBuffer()).includes("Review the patch")).toBe(false);

    const query = { from: start + 6_000, to: start + 8_000, mode: "usage" as const, model: "gpt-6.2-sol" };
    expect((await readCodexPrompts(query, file, roots)).prompts).toEqual([
      { at: start + 4_000, preview: "Review the patch", tokens: 23 },
    ]);
    expect((await readCodexPrompts({ ...query, includeCache: false, to: start + 9_000 }, file, roots)).prompts).toEqual([
      { at: start + 7_000, preview: "Focus on the tests", tokens: 5 },
      { at: start + 4_000, preview: "Review the patch", tokens: 11 },
    ]);
    expect((await readCodexPrompts({ ...query, model: "another-model" }, file, roots)).total).toBe(0);

    expect((await readCodexPrompts({
      from: start + 8_000, to: start + 12_000, mode: "burndown",
    }, file, roots)).prompts.map(({ preview }) => preview)).toEqual([
      "A prompt with no tokens yet", "Focus on the tests",
    ]);
    rmSync(log);
    expect((await readCodexPrompts(query, file, roots)).total).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collects model, effort, and tokens once, max-upserts streamed Claude chunks, and retries an incomplete log line", async () => {
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
    const nineDaysAgo = now - 9 * 24 * 60 * 60_000;
    const codexLog = join(codex, "session.jsonl");
    const claudeLog = join(claude, "session.jsonl");

    // Claude streams partial output_tokens first, then final output_tokens on the same message.id.
    const partialChunk = {
      type: "assistant",
      timestamp,
      sessionId: "sess-claude-1",
      effort: "medium",
      perTurnEffort: "high",
      message: {
        id: "msg_123",
        model: "claude-opus-4-8",
        content: "private text",
        usage: {
          input_tokens: 1200,
          output_tokens: 20,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 300,
          output_tokens_details: { thinking_tokens: 10 },
        },
      },
    };
    const finalChunk = {
      ...partialChunk,
      timestamp: new Date(now + 2000).toISOString(),
      message: {
        ...partialChunk.message,
        usage: {
          input_tokens: 1200,
          output_tokens: 450,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 300,
          output_tokens_details: { thinking_tokens: 180 },
        },
      },
    };
    const historicalEntry = {
      ...partialChunk,
      timestamp: new Date(nineDaysAgo).toISOString(),
      message: {
        id: "msg_old",
        model: "claude-opus-4-8",
        usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };

    writeFileSync(
      claudeLog,
      [
        partialChunk,
        finalChunk,
        { ...partialChunk, message: { id: "msg_synthetic", model: "<synthetic>" } },
        historicalEntry,
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );

    const context = JSON.stringify({
      type: "turn_context",
      timestamp,
      payload: { turn_id: "turn-123", model: "gpt-6.2-sol", effort: "xhigh", cwd: "/private/path" },
    });
    writeFileSync(codexLog, `malformed\n${context.slice(0, -2)}`);

    function reads() {
      const db = openHistoryDatabase(file, true);
      try {
        return db.query(`
          SELECT provider, observed_at, model, effort, source_kind,
                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
          FROM model_usage
          ORDER BY provider, observed_at, rowid
        `).all();
      } finally {
        db.close();
      }
    }

    await syncModelUsage(file, [...roots], now);
    expect(reads()).toEqual([
      {
        provider: "claude",
        observed_at: nineDaysAgo,
        model: "claude-opus-4-8",
        effort: "high",
        source_kind: "usage",
        input_tokens: 500,
        output_tokens: 100,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      },
      {
        provider: "claude",
        observed_at: now,
        model: "claude-opus-4-8",
        effort: "high",
        source_kind: "usage",
        input_tokens: 1200,
        output_tokens: 450,
        cache_read_tokens: 5000,
        cache_write_tokens: 300,
        reasoning_tokens: 180,
      },
    ]);

    const noEffort = JSON.stringify({
      type: "turn_context",
      timestamp,
      payload: { turn_id: "turn-456", model: "gpt-6.2-sol" },
    });
    appendFileSync(codexLog, `${context.slice(-2)}\n${noEffort}\n`);
    await Promise.all([syncModelUsage(file, [...roots], now), syncModelUsage(file, [...roots], now)]);
    await syncModelUsage(file, [...roots], now);

    const codexRows = reads().filter((r: any) => r.provider === "codex");
    expect(codexRows).toEqual([
      {
        provider: "codex",
        observed_at: now,
        model: "gpt-6.2-sol",
        effort: "xhigh",
        source_kind: "turn",
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
      },
      {
        provider: "codex",
        observed_at: now,
        model: "gpt-6.2-sol",
        effort: null,
        source_kind: "turn",
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extracts Codex tokens with uncached input subtraction, twin deduplication, incremental cumulative deltas, and fork exclusion", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-usage-codex-"));
  try {
    const file = join(root, "history.sqlite");
    const codex = join(root, "codex");
    mkdirSync(codex);
    const now = Date.parse("2026-11-24T10:00:00Z");

    // 1. Main session with paired modern + legacy records across two incremental polls.
    const mainLog = join(codex, "main.jsonl");
    const part1 = [
      {
        type: "session_meta",
        timestamp: new Date(now - 60_000).toISOString(),
        payload: { id: "019ab000-0000-7000-8000-000000000001", model_provider: "openai" },
      },
      {
        type: "turn_context",
        timestamp: new Date(now - 50_000).toISOString(),
        payload: { turn_id: "019ab000-0010-7000-8000-000000000001", model: "gpt-6.2-sol", effort: "high" },
      },
      {
        type: "token_usage_record",
        timestamp: new Date(now - 45_000).toISOString(),
        payload: {
          response_id: "resp_1",
          turn_id: "019ab000-0010-7000-8000-000000000001",
          usage: {
            input_tokens: 1000,
            cached_input_tokens: 600,
            cache_write_input_tokens: 0,
            output_tokens: 200,
            reasoning_output_tokens: 50,
          },
          thread_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 600,
            output_tokens: 200,
            reasoning_output_tokens: 50,
          },
        },
      },
      // Legacy twin for resp_1: must NOT double count!
      {
        type: "event_msg",
        timestamp: new Date(now - 44_000).toISOString(),
        payload: {
          type: "token_count",
          turn_id: "019ab000-0010-7000-8000-000000000001",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 600,
              output_tokens: 200,
              reasoning_output_tokens: 50,
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 600,
              output_tokens: 200,
              reasoning_output_tokens: 50,
            },
          },
        },
      },
    ];
    writeFileSync(mainLog, part1.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await syncModelUsage(file, [{ provider: "codex", path: codex }], now);

    // Append a second legacy-only cumulative turn; persisted state_json must compute exact delta!
    const part2 = [
      {
        type: "event_msg",
        timestamp: new Date(now - 20_000).toISOString(),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 2500,
              cached_input_tokens: 1800,
              output_tokens: 350,
              reasoning_output_tokens: 90,
            },
          },
        },
      },
    ];
    appendFileSync(mainLog, part2.map((e) => JSON.stringify(e)).join("\n") + "\n");

    // 2. Forked child thread: replays parent usage before forkStartMs, then executes a new child turn.
    // Parent timestamp hex: 0x019ab0000000, Child thread created at: 0x019ab0001000, New turn at: 0x019ab0002000.
    const forkLog = join(codex, "fork.jsonl");
    const forkLines = [
      {
        type: "session_meta",
        timestamp: new Date(now - 15_000).toISOString(),
        payload: {
          id: "019ab000-1000-7000-8000-000000000002",
          forked_from_id: "019ab000-0000-7000-8000-000000000001",
          model_provider: "openai",
        },
      },
      // Replayed parent turn (turnMs < forkStartMs) — must be excluded while establishing cumulative baseline!
      {
        type: "turn_context",
        timestamp: new Date(now - 14_000).toISOString(),
        payload: { turn_id: "019ab000-0010-7000-8000-000000000001", model: "gpt-6.2-sol", effort: "high" },
      },
      {
        type: "event_msg",
        timestamp: new Date(now - 13_000).toISOString(),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 2500, cached_input_tokens: 1800, output_tokens: 350, reasoning_output_tokens: 90 },
          },
        },
      },
      // New child turn strictly newer than forkStartMs — only the delta above 2500/1800/350/90 should be counted!
      {
        type: "turn_context",
        timestamp: new Date(now - 5_000).toISOString(),
        payload: { turn_id: "019ab000-2000-7000-8000-000000000003", model: "gpt-6.2-sol", effort: "xhigh" },
      },
      {
        type: "event_msg",
        timestamp: new Date(now - 4_000).toISOString(),
        payload: {
          type: "token_count",
          turn_id: "019ab000-2000-7000-8000-000000000003",
          info: {
            total_token_usage: { input_tokens: 3000, cached_input_tokens: 2100, output_tokens: 450, reasoning_output_tokens: 110 },
          },
        },
      },
    ];
    writeFileSync(forkLog, forkLines.map((e) => JSON.stringify(e)).join("\n") + "\n");

    await syncModelUsage(file, [{ provider: "codex", path: codex }], now);

    const db = openHistoryDatabase(file, true);
    try {
      const tokenRows = db.query(`
        SELECT model, effort, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
        FROM model_usage
        WHERE source_kind = 'usage'
        ORDER BY observed_at
      `).all();
      expect(tokenRows).toEqual([
        // resp_1: 1000 raw input - 600 cached = 400 uncached
        { model: "gpt-6.2-sol", effort: "high", input_tokens: 400, output_tokens: 200, cache_read_tokens: 600, cache_write_tokens: 0, reasoning_tokens: 50 },
        // delta from main part2: (2500-1000)=1500 raw - (1800-600)=1200 cached = 300 uncached; out=150; reasoning=40
        { model: "gpt-6.2-sol", effort: "high", input_tokens: 300, output_tokens: 150, cache_read_tokens: 1200, cache_write_tokens: 0, reasoning_tokens: 40 },
        // fork child delta only: (3000-2500)=500 raw - (2100-1800)=300 cached = 200 uncached; out=100; reasoning=20
        { model: "gpt-6.2-sol", effort: "xhigh", input_tokens: 200, output_tokens: 100, cache_read_tokens: 300, cache_write_tokens: 0, reasoning_tokens: 20 },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collects antigravity model, thinking effort, and token counts from brain transcripts", async () => {
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

    const step1 = {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      created_at: createdAt,
      model: "gemini-4-neon-medium",
      input_tokens: 3154,
      cache_read_tokens: 10191,
      output_tokens: 554,
    };
    const step2 = { step_index: 2, type: "PLANNER_RESPONSE", created_at: createdAt, model: "gemini-flash-worker-agy" };
    const ignored = { step_index: 3, type: "USER_INPUT", created_at: createdAt, model: "gemini-4-neon-high" };
    writeFileSync(logA, `${[step1, step2, ignored].map((e) => JSON.stringify(e)).join("\n")}\n`);
    writeFileSync(fullLogA, `${JSON.stringify({ step_index: 99, type: "PLANNER_RESPONSE", created_at: createdAt, model: "gemini-4-neon-xhigh" })}\n`);
    writeFileSync(logB, `${JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: createdAt, model: "gemini-4-hydrogen-xhigh", input_tokens: 800, cache_read_tokens: 200, output_tokens: 120 })}\n`);

    await syncModelUsage(file, [{ provider: "antigravity", path: brain }], now);
    await syncModelUsage(file, [{ provider: "antigravity", path: brain }], now);

    const db = openHistoryDatabase(file, true);
    try {
      const rows = db.query(`
        SELECT provider, observed_at, model, effort, input_tokens, output_tokens, cache_read_tokens
        FROM model_usage ORDER BY model, effort
      `).all();
      expect(rows).toEqual([
        { provider: "antigravity", observed_at: now, model: "gemini-4-hydrogen", effort: "xhigh", input_tokens: 800, output_tokens: 120, cache_read_tokens: 200 },
        { provider: "antigravity", observed_at: now, model: "gemini-4-neon", effort: "medium", input_tokens: 3154, output_tokens: 554, cache_read_tokens: 10191 },
        { provider: "antigravity", observed_at: now, model: "gemini-flash-worker-agy", effort: null, input_tokens: null, output_tokens: null, cache_read_tokens: null },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrates a v1 history.sqlite database cleanly to v2 and backfills tokens from existing logs", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-usage-migrate-"));
  try {
    const file = join(root, "history.sqlite");
    const claude = join(root, "claude");
    mkdirSync(claude);
    const now = Date.parse("2026-11-24T12:00:00Z");
    const claudeLog = join(claude, "session.jsonl");
    const line = JSON.stringify({
      type: "assistant",
      timestamp: new Date(now).toISOString(),
      sessionId: "sess-1",
      effort: "high",
      message: {
        id: "msg_v1",
        model: "claude-opus-4-8",
        usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100 },
      },
    }) + "\n";
    writeFileSync(claudeLog, line);

    // Seed a genuine v1 SQLite file with pre-existing offset & row (no token columns).
    const v1 = new Database(file, { create: true });
    v1.exec(`
      CREATE TABLE allowance_readings (provider TEXT NOT NULL, read_at NUMERIC NOT NULL, samples TEXT NOT NULL, PRIMARY KEY (provider, read_at));
      CREATE TABLE model_usage (provider TEXT NOT NULL, event_id TEXT NOT NULL, observed_at INTEGER NOT NULL, model TEXT NOT NULL, effort TEXT, PRIMARY KEY (provider, event_id));
      CREATE TABLE model_log_offsets (log_id TEXT PRIMARY KEY NOT NULL, byte_offset INTEGER NOT NULL, modified_at REAL NOT NULL);
      INSERT INTO model_usage (provider, event_id, observed_at, model, effort) VALUES ('claude', 'legacy-only-event', ${now - 3600_000}, 'claude-sonnet-4-6', 'medium');
      PRAGMA user_version = 1;
    `);
    v1.close();

    const stats = await syncModelUsage(file, [{ provider: "claude", path: claude }], now);
    expect(stats.pendingFiles).toBe(0);
    expect(stats.processedFiles).toBe(1);

    const db = openHistoryDatabase(file, true);
    try {
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
      const offsets = db.query<{ parser_version: number }, []>("SELECT parser_version FROM model_log_offsets").all();
      expect(offsets).toEqual([{ parser_version: PARSER_VERSION }]);
      const rows = db.query<{ model: string; input_tokens: number | null; cache_read_tokens: number | null }, []>(
        "SELECT model, input_tokens, cache_read_tokens FROM model_usage ORDER BY observed_at",
      ).all();
      expect(rows).toEqual([
        { model: "claude-sonnet-4-6", input_tokens: null, cache_read_tokens: null },
        { model: "claude-opus-4-8", input_tokens: 900, cache_read_tokens: 4000 },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
