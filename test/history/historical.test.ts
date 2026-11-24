import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHorizonWindow, readHistorical } from "../../src/history/historical.ts";
import { openHistoryDatabase } from "../../src/history/db.ts";

function insertUsage(
  file: string,
  rows: Array<{
    provider: string;
    id: string;
    at: number;
    model: string;
    effort?: string | null;
    session?: string | null;
    sourceKind?: string | null;
    input?: number | null;
    output?: number | null;
    cacheRead?: number | null;
    cacheWrite?: number | null;
    reasoning?: number | null;
  }>,
) {
  const db = openHistoryDatabase(file);
  try {
    const stmt = db.query(`
      INSERT INTO model_usage (
        provider, event_id, observed_at, model, effort, session_id, source_kind,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      stmt.run(
        r.provider,
        r.id,
        r.at,
        r.model,
        r.effort ?? null,
        r.session ?? null,
        r.sourceKind === undefined ? (r.input != null ? "usage" : null) : r.sourceKind,
        r.input ?? null,
        r.output ?? null,
        r.cacheRead ?? null,
        r.cacheWrite ?? null,
        r.reasoning ?? null,
      );
    }
  } finally {
    db.close();
  }
}

describe("buildHorizonWindow", () => {
  const now = new Date(2026, 10, 24, 14, 30, 0, 0).getTime(); // Tue Nov 24, 2026 14:30 local

  test("builds 24 hourly buckets for D, 7 daily for W, calendar days for M, and 52 weekly for Y", () => {
    const d = buildHorizonWindow("d", 0, now);
    expect(d.buckets).toHaveLength(24);
    expect(d.label).toContain("Today");

    const w = buildHorizonWindow("w", 0, now);
    expect(w.buckets).toHaveLength(7);
    expect(w.buckets[0]!.axisLabel).toStartWith("Mon");
    expect(w.buckets[6]!.axisLabel).toStartWith("Sun");

    const m = buildHorizonWindow("m", 0, now);
    expect(m.buckets).toHaveLength(30); // November has 30 days
    expect(m.label).toBe("November 2026");

    const y = buildHorizonWindow("y", 0, now);
    expect(y.buckets).toHaveLength(52);
    expect(y.label).toBe("2026");
    // Final bucket extends through Jan 1 of next year so Dec 31 is never dropped.
    expect(y.buckets[0]!.startMs).toBe(new Date(2026, 0, 1, 0, 0, 0, 0).getTime());
    expect(y.buckets[51]!.endMs).toBe(new Date(2027, 0, 1, 0, 0, 0, 0).getTime());
  });
});

describe("readHistorical", () => {
  test("aggregates models, folds >7 into Other, toggles cache, computes deltas and effort shares", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-test-"));
    try {
      const file = join(root, "history.sqlite");
      const now = new Date(2026, 10, 24, 15, 0, 0, 0).getTime();
      const oct10 = new Date(2026, 9, 10, 10, 0, 0, 0).getTime();
      const nov05 = new Date(2026, 10, 5, 11, 0, 0, 0).getTime();
      const nov20 = new Date(2026, 10, 20, 14, 0, 0, 0).getTime();

      const seed: Parameters<typeof insertUsage>[1] = [
        // Previous month baseline for model-1 (1,000 total with cache)
        { provider: "claude", id: "prev-1", at: oct10, model: "model-1", effort: "high", session: "s0", input: 200, output: 100, cacheRead: 700, cacheWrite: 0, reasoning: 40 },
        // Current month: 9 distinct models so top 7 stay separate and 2 fold into "Other"
        { provider: "claude", id: "c-1a", at: nov05, model: "model-1", effort: "xhigh", session: "s1", input: 500, output: 200, cacheRead: 1300, cacheWrite: 0, reasoning: 80 },
        { provider: "claude", id: "c-1b", at: nov20, model: "model-1", effort: "high", session: "s1", input: 300, output: 100, cacheRead: 600, cacheWrite: 0, reasoning: 20 },
        { provider: "codex", id: "c-2", at: nov20, model: "model-2", effort: "medium", session: "s2", input: 400, output: 100, cacheRead: 1000, cacheWrite: 0, reasoning: 50 },
        { provider: "antigravity", id: "c-3", at: nov20, model: "model-3", session: "s3", input: 200, output: 100, cacheRead: 700, cacheWrite: 0, reasoning: 0 },
        { provider: "claude", id: "c-4", at: nov20, model: "model-4", session: "s4", input: 100, output: 100, cacheRead: 500, cacheWrite: 0, reasoning: 0 },
        { provider: "claude", id: "c-5", at: nov20, model: "model-5", session: "s5", input: 100, output: 100, cacheRead: 400, cacheWrite: 0, reasoning: 0 },
        { provider: "codex", id: "c-6", at: nov20, model: "model-6", session: "s6", input: 100, output: 100, cacheRead: 300, cacheWrite: 0, reasoning: 0 },
        { provider: "codex", id: "c-7", at: nov20, model: "model-7", session: "s7", input: 100, output: 100, cacheRead: 200, cacheWrite: 0, reasoning: 0 },
        { provider: "antigravity", id: "c-8", at: nov20, model: "model-8", session: "s8", input: 100, output: 50, cacheRead: 100, cacheWrite: 0, reasoning: 0 },
        { provider: "antigravity", id: "c-9", at: nov20, model: "model-9", session: "s9", input: 50, output: 50, cacheRead: 50, cacheWrite: 0, reasoning: 0 },
        // Legacy unmeasured v1 row (source_kind = NULL, input_tokens = NULL)
        { provider: "claude", id: "legacy-1", at: nov05, model: "model-legacy", sourceKind: null, input: null },
        // Codex turn_context metadata row (source_kind = 'turn', input_tokens = NULL) — should NOT inflate unmeasuredEvents
        { provider: "codex", id: "turn-1", at: nov20, model: "model-2", sourceKind: "turn", input: null },
      ];
      insertUsage(file, seed);

      const withCache = readHistorical({ horizon: "m", offset: 0, includeCache: true, now }, file);
      expect(withCache.series.models).toEqual([
        "model-1", "model-2", "model-3", "model-4", "model-5", "model-6", "model-7", "Other",
      ]);
      expect(withCache.summary.unmeasuredEvents).toBe(1);
      expect(withCache.summary.sessions).toBe(9);
      expect(withCache.summary.reasoningTokens).toBe(150);
      // model-1: 2000 + 1000 = 3000 vs 1000 prev => +200%
      const leader1 = withCache.leaderboard.entries[0]!;
      expect(leader1.model).toBe("model-1");
      expect(leader1.tokens).toBe(3000);
      expect(leader1.deltaKind).toBe("up");
      expect(leader1.deltaPct).toBe(200);
      expect(leader1.efforts).toEqual([
        { effort: "xhigh", sharePct: 66.7 },
        { effort: "high", sharePct: 33.3 },
      ]);
      // model-8 (250) + model-9 (150) = 400 folded into "Other" on Nov 20 (bucket index 19)
      expect(withCache.series.buckets[19]!.byModel.Other).toBe(400);
      // Future buckets after Nov 24 are flagged future=true and cumulative stops cleanly
      expect(withCache.series.buckets[24]!.future).toBe(true);
      expect(withCache.series.buckets[24]!.cumulativeTotal).toBe(0);
      expect(withCache.series.buckets[23]!.cumulativeTotal).toBe(withCache.summary.totalTokens);

      // Cache excluded: totals reflect input + output only
      const noCache = readHistorical({ horizon: "m", offset: 0, includeCache: false, now }, file);
      expect(noCache.leaderboard.entries[0]!.tokens).toBe(1100); // (500+200) + (300+100)
      expect(noCache.summary.totalTokens).toBe(noCache.summary.inputTokens + noCache.summary.outputTokens);

      // Provider filter scopes chart & leaderboard
      const codexOnly = readHistorical({ horizon: "m", offset: 0, provider: "codex", now }, file);
      expect(codexOnly.leaderboard.entries.map((e) => e.model)).toEqual(["model-2", "model-6", "model-7"]);
      expect(codexOnly.facets.providers.length).toBe(3); // provider facet ignores its own filter
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("includes cache_write_tokens in the cache-hit denominator", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-cache-hit-"));
    try {
      const file = join(root, "history.sqlite");
      const now = new Date(2026, 10, 24, 15, 0, 0, 0).getTime();
      insertUsage(file, [
        { provider: "claude", id: "cw-1", at: now - 60_000, model: "claude-opus-4-8", session: "s1", input: 0, output: 50, cacheRead: 100, cacheWrite: 900, reasoning: 0 },
      ]);
      const data = readHistorical({ horizon: "d", offset: 0, now }, file);
      expect(data.summary.cacheHitRate).toBe(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("historical.js UI rendering", () => {
  function mockElement() {
    const node = {
      name: "",
      kind: "el",
      items: [] as unknown[],
      cardContent: null as unknown,
      triggerEl: null as unknown,
      calls: [] as unknown[][],
      id(name: string) { this.name = name; return this; },
      content(c: unknown) { this.cardContent = c; return this; },
      trigger(t: unknown) { this.triggerEl = t; return this; },
      child(item: unknown) { this.items.push(item); return this; },
      children(items: unknown[]) { this.items.push(...items); return this; },
      map<T>(transform: (el: typeof this) => T) { return transform(this); },
      when(cond: unknown, apply: (el: typeof this) => unknown) { if (cond) apply(this); return this; },
    };
    return new Proxy(node, {
      get(target, key, receiver) {
        if (typeof key !== "string" || key in target) return Reflect.get(target, key, receiver);
        return (...args: unknown[]) => { target.calls.push([key, ...args]); return receiver; };
      },
    });
  }

  type Element = ReturnType<typeof mockElement>;

  function findById(root: Element, id: string): Element | undefined {
    if (root.name === id) return root;
    for (const child of root.items) {
      if (typeof child !== "object" || !child) continue;
      const found = findById(child as Element, id);
      if (found) return found;
    }
  }

  function labels(root: Element): string[] {
    return root.items.flatMap((item) => typeof item === "string" ? [item] : labels(item as Element));
  }

  test("renders both stacked bar segments and PathBuilder polylines with interactive hover cards", async () => {
    const paintedPaths: Array<{ ops: unknown[]; paint: unknown }> = [];
    const makeBuilder = (mode: string) => {
      const ops: unknown[] = [[mode]];
      const builder: any = {
        move_to: (...args: unknown[]) => { ops.push(["move_to", ...args]); return builder; },
        line_to: (...args: unknown[]) => { ops.push(["line_to", ...args]); return builder; },
        dash_array: (...args: unknown[]) => { ops.push(["dash_array", ...args]); return builder; },
        close: () => { ops.push(["close"]); return builder; },
        build: () => ({ ops }),
      };
      return builder;
    };

    mock.module("gpui-kit", () => ({
      div: mockElement,
      PathBuilder: {
        stroke: (w: number) => makeBuilder(`stroke:${w}`),
        fill: () => makeBuilder("fill"),
      },
      Background: {
        solid: (color: string) => ({ color, opacity: (f: number) => ({ color, opacity: f }) }),
      },
    }));
    mock.module("gpui-base", () => ({
      h_flex: mockElement,
      v_flex: mockElement,
      Button: { new: (id: string) => mockElement().id(id) },
      HoverCard: { new: (id: string) => mockElement().id(id) },
      Popover: { new: (id: string) => mockElement().id(id) },
    }));
    (globalThis as any).window = {
      paint_path: (path: { ops: unknown[] }, paint: unknown) => {
        paintedPaths.push({ ops: path.ops, paint });
        return mockElement();
      },
    };

    const { DEFAULT_CHART_PREFS, historicalView, niceMax, normalizeChartPrefs, offsetForTimestamp } = await import("../../herdr-app/mods/usage-monitor/historical.js");

    expect(normalizeChartPrefs(null)).toEqual(DEFAULT_CHART_PREFS);
    expect(normalizeChartPrefs({
      horizon: "y",
      chartMode: "line",
      lineMode: "cumulative",
      groupBy: "type",
      includeCache: false,
      providerFilter: "claude",
      modelFilter: "claude-opus-4-8",
    })).toEqual({
      horizon: "y",
      chartMode: "line",
      lineMode: "cumulative",
      groupBy: "type",
      includeCache: false,
      providerFilter: "claude",
      modelFilter: "claude-opus-4-8",
    });
    expect(normalizeChartPrefs({ horizon: "invalid", chartMode: 42, groupBy: "unknown", includeCache: "yes" })).toEqual(DEFAULT_CHART_PREFS);
    expect(normalizeChartPrefs('{"lineMode":"cumulative"}')).toMatchObject({ lineMode: "cumulative", groupBy: "model" });

    expect(niceMax(142_000_000)).toBe(150_000_000);
    expect(niceMax(0)).toBe(0);
    expect(offsetForTimestamp("m", new Date(2026, 8, 15).getTime(), new Date(2026, 10, 24).getTime())).toBe(-2);

    const root = mkdtempSync(join(tmpdir(), "historical-ui-"));
    try {
      const file = join(root, "history.sqlite");
      const now = new Date(2026, 10, 24, 15, 0, 0, 0).getTime();
      insertUsage(file, [
        { provider: "claude", id: "u1", at: new Date(2026, 10, 23, 10).getTime(), model: "claude-opus-4-8", effort: "high", session: "s1", input: 1000, output: 400, cacheRead: 5000, cacheWrite: 0, reasoning: 100 },
        { provider: "codex", id: "u2", at: new Date(2026, 10, 24, 11).getTime(), model: "gpt-6.2-sol", effort: "xhigh", session: "s2", input: 800, output: 300, cacheRead: 1500, cacheWrite: 500, reasoning: 80 },
      ]);
      const data = readHistorical({ horizon: "w", offset: 0, now }, file);
      const t = {
        surface: "#18181b", popover: "#111113", raised: "#27272a", hover: "#3f3f46", selected: "#323238",
        border: "#2e2e32", foreground: "#f4f4f5", muted: "#a1a1aa", dim: "#71717a", accent: "#3b82f6", blocked: "#ef4444",
      };
      const noop = () => {};
      const state = {
        historical: data,
        historicalError: "",
        horizon: "w",
        offset: 0,
        providerFilter: "all",
        modelFilter: "all",
        includeCache: true,
        chartMode: "both",
        lineMode: "models",
        groupBy: "model",
        openFilter: null,
        width: 1200,
        setOpenFilter: noop,
        setHorizon: noop,
        stepOffset: noop,
        resetOffset: noop,
        jumpToLatest: noop,
        setProviderFilter: noop,
        setModelFilter: noop,
        clearFilters: noop,
        toggleCache: noop,
        setChartMode: noop,
        setGroupBy: mock((groupBy: string) => { state.groupBy = groupBy; }),
        setLineMode: noop,
        retryHistorical: noop,
      };
      const tree = historicalView(t, state);

      expect(tree).toBeTruthy();
      // 2 models + 1 dashed total line = 3 painted PathBuilder paths!
      expect(paintedPaths).toHaveLength(3);
      expect(paintedPaths[0]!.ops.some((op: any) => op[0] === "dash_array")).toBe(true);

      // Cumulative line mode paints area fill + total stroke + 2 model strokes = 4 paths!
      paintedPaths.length = 0;
      const cumTree = historicalView(t, { ...state, chartMode: "line", lineMode: "cumulative" });
      expect(cumTree).toBeTruthy();
      expect(paintedPaths).toHaveLength(4);
      expect(paintedPaths[0]!.ops[0]).toEqual(["fill"]);

      const splitButton = findById(tree, "hist-group-type")!;
      const click = splitButton.calls.find(([method]) => method === "on_click")![1] as (event: object, cx: object) => void;
      click({}, {});
      expect(state.groupBy).toBe("type");
      paintedPaths.length = 0;
      const split = historicalView(t, { ...state, lineMode: "cumulative" });
      const hoverLabels = (view: Element, id: string) => labels(findById(view, id)!.cardContent as Element);
      expect(hoverLabels(split, "hist-bar-w-0-1")).toEqual([
        "Tue, Nov 24", "3,100 tokens · 1 call", "Input", "800 (25.8%)", "Output", "300 (9.7%)", "Prompt cache", "2,000 (64.5%)",
      ]);
      expect(hoverLabels(split, "hist-line-w-0-cumulative-1")).toEqual([
        "Tue, Nov 24", "9,500 cumulative tokens", "Input", "1,800 (18.9%)", "Output", "700 (7.4%)", "Prompt cache", "7,000 (73.7%)",
      ]);
      expect(hoverLabels(split, "hist-line-w-0-cumulative-2")).toContain("Future time slot");
      const bar = findById(split, "hist-bar-w-0-1")!.triggerEl as Element;
      const segments = (bar.items[0] as Element).items as Element[];
      expect(segments.map((el) => el.calls.find(([method]) => method === "flex_grow")?.[1]))
        .toEqual([2000, 300, 800]);
      expect(paintedPaths).toHaveLength(4); // combined total, input, output and cache
      expect(paintedPaths[0]!.ops).toContainEqual(["dash_array", [4, 3]]);
      expect(paintedPaths.every(({ ops }) => ops.filter((op: any) => op[0] === "line_to").length === 1)).toBe(true);
      for (const [i, tokens] of [9500, 1800, 700, 7000].entries()) {
        const [, , y] = paintedPaths[i]!.ops.at(-1) as [string, string, number];
        expect(y).toBeCloseTo(3 + (1 - tokens / 10_000) * (148 - 6));
      }

      const filtered = readHistorical({ horizon: "w", model: "gpt-6.2-sol", includeCache: false, now }, file);
      paintedPaths.length = 0;
      const uncached = historicalView(t, { ...state, historical: filtered, includeCache: false, modelFilter: "gpt-6.2-sol" });
      expect(hoverLabels(uncached, "hist-line-w-0-models-1")).toEqual([
        "Tue, Nov 24", "1,100 tokens · 1 call", "Input", "800 (72.7%)", "Output", "300 (27.3%)",
      ]);
      expect(paintedPaths).toHaveLength(3);

      // Hourly D horizon and 52-week Y horizon + stepping backward work cleanly.
      const dayData = readHistorical({ horizon: "d", offset: -1, now }, file);
      expect(dayData.series.buckets).toHaveLength(24);
      expect(dayData.range.hasNext).toBe(true);
      expect(dayData.summary.totalTokens).toBe(6400);

      const yearData = readHistorical({ horizon: "y", offset: 0, now }, file);
      expect(yearData.series.buckets).toHaveLength(52);
      expect(yearData.summary.totalTokens).toBe(9500);
    } finally {
      rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).window;
    }
  });
});
