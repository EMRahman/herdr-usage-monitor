import { expect, mock, test } from "bun:test";

function element() {
  const node = {
    name: "",
    cardContent: null as unknown,
    openDelay: null as number | null,
    closeDelay: null as number | null,
    items: [] as unknown[],
    calls: [] as unknown[][],
    id(name: string) { this.name = name; return this; },
    content(content: unknown) { this.cardContent = content; return this; },
    open_delay(ms: number) { this.openDelay = ms; return this; },
    close_delay(ms: number) { this.closeDelay = ms; return this; },
    child(item: unknown) { this.items.push(item); return this; },
    children(items: unknown[]) { this.items.push(...items); return this; },
    when(condition: boolean, apply: (el: typeof this) => unknown) { if (condition) apply(this); return this; },
  };
  return new Proxy(node, {
    get(target, key, receiver) {
      if (typeof key !== "string" || key in target) return Reflect.get(target, key, receiver);
      return (...args: unknown[]) => { target.calls.push([key, ...args]); return receiver; };
    },
  });
}

mock.module("gpui-kit", () => ({
  div: element,
  svg: element,
  PathBuilder: { stroke: () => element(), fill: () => element() },
  Background: { solid: () => ({ opacity: () => ({}) }) },
}));
mock.module("gpui-base", () => ({
  h_flex: element,
  v_flex: element,
  Button: { new: (id: string) => element().id(id) },
  HoverCard: { new: (id: string) => element().id(id) },
  Popover: { new: (id: string) => element().id(id) },
}));
const { burndownCards } = await import("../../herdr-app/mods/usage-monitor/burndown.js");
const { focusedProvider, panelWindows, rightPanel } = await import("../../herdr-app/mods/usage-monitor/panel.js");

type Element = ReturnType<typeof element>;

function hoverCards(node: unknown): Element[] {
  if (!node || typeof node !== "object") return [];
  const el = node as Element;
  return el.cardContent ? [el] : el.items.flatMap(hoverCards);
}

function elements(node: unknown): Element[] {
  if (!node || typeof node !== "object") return [];
  const el = node as Element;
  return [el, ...el.items.flatMap(elements)];
}

const style = (el: Element, name: string) => el.calls.find(([key]) => key === name)?.[1];

function labels(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (!node || typeof node !== "object") return [];
  return (node as Element).items.flatMap(labels);
}

test("hover opens immediately and lists provider activity through the current partial slice", () => {
  const start = Date.parse("2026-11-23T12:00:00Z");
  const end = start + 48 * 60_000;
  const now = start + 65_000;
  const series = {
    provider: "codex", label: "Weekly", length: end - start, start, end,
    left: 75, reset: new Date(end).toISOString(), runs: [[start, now, 75]],
  };
  const codex = { provider: "codex", model: "model-a", effort: "high" };
  const activity = [
    { ...codex, at: start - 1, model: "outside" },
    { ...codex, at: start + 5_000, model: "earlier" },
    { ...codex, at: start + 60_000 },
    { ...codex, at: start + 62_000 },
    { ...codex, at: now, model: "model-b", effort: null },
    { ...codex, at: now, provider: "claude", model: "other-provider" },
    { ...codex, at: now + 1, model: "future" },
  ];
  const [card] = burndownCards({}, [series], activity, now);
  const cards = hoverCards(card!.rows[0]);
  expect(cards.map(({ openDelay, closeDelay }) => [openDelay, closeDelay])).toEqual([[0, 0], [0, 0]]);
  const tips = cards.map((card) => labels(card.cardContent).join("\n"));
  expect(tips[0]).toContain("earlier · high effort");
  const last = tips[1]!;
  expect(last).toContain("75% left");
  expect(last).toContain("Local activity");
  expect(last.match(/model-a · high effort/g)).toHaveLength(1);
  expect(last).toContain("model-b · effort unavailable");
  expect(tips.join("\n")).not.toMatch(/outside|other-provider|future/);
});

test("Antigravity hovers show activity from their quota group and subscription", () => {
  const start = Date.parse("2026-11-23T12:00:00Z");
  const now = start + 60_000;
  const hour = 3_600_000;
  const series = (group: string, length: number, label: string) => ({
    provider: "antigravity", group, label, length, start, end: start + length,
    left: 75, reset: new Date(start + length).toISOString(), runs: [[start, now, 75]],
  });
  const activity = [
    { provider: "antigravity", model: "gemini-4-hydrogen", effort: "high" },
    { provider: "antigravity", model: "gemini-4-argon-tiered", effort: "high" },
    { provider: "antigravity", model: "claude-opus-5-5", effort: "medium" },
    { provider: "antigravity", model: "gpt-oss-120b", effort: null },
    { provider: "claude", model: "claude-sonnet-5-5", effort: "high" },
    { provider: "codex", model: "gpt-6.2-sol", effort: "high" },
  ].map((event) => ({ ...event, at: now }));
  const [card] = burndownCards({}, [
    series("Gemini Models", 5 * hour, "5h limit"),
    series("Claude and GPT models", 5 * hour, "5h limit"),
    series("Claude and GPT models", 168 * hour, "Weekly limit"),
    series("Gemini 4 Argon", 168 * hour, "Weekly limit"),
  ], activity, now);

  const tips = card!.rows.map((row) => labels(hoverCards(row)[0]!.cardContent));
  const modelLabels = tips.map((tip) => tip.slice(2));
  const sharedModels = ["claude-opus-5-5 · medium effort", "gpt-oss-120b · effort unavailable"];
  expect(modelLabels).toEqual([
    ["gemini-4-hydrogen · high effort", "gemini-4-argon-tiered · high effort"],
    sharedModels,
    sharedModels,
    ["gemini-4-argon-tiered · high effort"],
  ]);
});

test("labels an unstarted 100% window with Now on the left", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const end = now + 5 * 60 * 60_000;
  const series = {
    provider: "claude", label: "5h session", length: end - now, start: now, end,
    left: 100, reset: null, runs: [[now, now, 100]],
  };
  const [card] = burndownCards({}, [series], [], now);
  const text = labels(card!.rows[0]);
  expect(text).toContain("100% left");
  expect(text[text.length - 2]).toBe("Now");
  expect(text[text.length - 1]).not.toBe("Now");
});

test("the endpoint dot stays on the last allowance step when readings stop before now", () => {
  const start = Date.parse("2026-11-23T12:00:00Z");
  const hour = 3_600_000;
  const end = start + 5 * hour;
  const now = start + 3 * hour;
  const series = {
    provider: "codex", label: "5h session", length: end - start, start, end,
    left: 75, reset: new Date(end).toISOString(),
  };
  const theme = { accent: "#88aaff" };
  const dotsFor = (runs: number[][]) => {
    const [card] = burndownCards(theme, [{ ...series, runs }], [], now);
    return elements(card!.rows[0]).filter((el) => style(el, "bg") === theme.accent
      && el.calls.some(([key]) => key === "rounded_full"));
  };
  const dots = dotsFor([[start, start + hour, 90], [start + hour, start + 2 * hour, 75]]);
  expect(dots).toHaveLength(1);
  const dot = dots[0]!;
  expect(style(dot, "left")).toBe("40%");
  expect(Number(style(dot, "top")) + Number(style(dot, "size")) / 2).toBe(22);
  expect(dotsFor([])).toHaveLength(0);
});

test("shades the gap to an even pace: green ahead, yellow a little behind, red well behind", () => {
  const hour = 60 * 60_000;
  const start = Date.parse("2026-11-23T00:00:00Z");
  const end = start + 10 * hour;
  const now = start + 5 * hour;
  const series = {
    provider: "codex", label: "Weekly", length: end - start, start, end,
    left: 30, reset: new Date(end).toISOString(),
    // Even pace is 95-100% over the first hour, 70-80% over the third, 50-60% over the fifth.
    runs: [[start, start + hour, 100], [start + 2 * hour, start + 3 * hour, 70], [start + 4 * hour, now, 30]],
  };
  const [card] = burndownCards({}, [series], [], now);
  const band = elements(card!.rows[0]).filter((el) => style(el, "opacity") === 0.22);
  const colors = band.map((el) => style(el, "bg"));
  expect([...new Set(colors)]).toEqual(["#2fbf71", "#d4a72c", "#e5534b"]);
  // Nothing is shaded in the gaps between runs or after now.
  const lefts = band.map((el) => Number.parseFloat(String(style(el, "left"))));
  expect(lefts.every((at) => at < 10 || (at >= 20 && at < 30) || (at >= 40 && at < 50))).toBe(true);
});

test("the right panel follows the actual terminal on split panes, peeks and agent blocks", () => {
  const codex = { address: "t1", program: { key: "codex" } };
  const claude = { address: "work/t1", report: { app: "claude-code" }, program: { key: "agent" } };
  const shell = { address: "t2", program: { key: "shell" } };
  const all = [codex, claude, shell];
  expect(focusedProvider({ terminal: "t1" }, all)).toBe("codex");
  expect(focusedProvider({ terminal: "work/t1" }, all)).toBe("claude");
  expect(focusedProvider({ terminal: "t1", shown: "work/t1" }, all)).toBe("claude");
  expect(focusedProvider({ agent: "work/t1" }, all)).toBe("claude");
  expect(focusedProvider({ terminal: "t1", shown: "t2" }, all)).toBeNull();
  expect(focusedProvider({ terminal: null }, all)).toBeNull();
});

test("the right panel selects the tracked account's main weekly quota and session quota", () => {
  const hour = 3_600_000;
  const series = (label: string, length: number, account: string, provider = "claude") => ({
    label, length: length * hour, account, provider,
  });
  const session = series("5h session", 5, "active");
  const week = series("7d weekly", 168, "active");
  const burndowns = [series("7d weekly", 168, "old"), series("7d Opus", 168, "active"),
    session, week, series("Weekly", 168, "codex-account", "codex")];
  expect(panelWindows({ activeAccounts: { claude: "active" }, burndowns }, "claude")).toEqual([session, week]);
  expect(panelWindows({ activeAccounts: { claude: "new" }, burndowns }, "claude")).toEqual([undefined, undefined]);
  expect(panelWindows({ burndowns }, "codex")).toEqual([undefined, burndowns[4]]);
});

test("detailed burndown cards put 5-hour before weekly within each group", () => {
  const start = Date.parse("2026-11-23T12:00:00Z");
  const hour = 3_600_000;
  const series = (label: string, lengthHours: number, group?: string) => ({
    provider: "antigravity", group, label, length: lengthHours * hour, start,
    end: start + lengthHours * hour, left: 80, reset: new Date(start + lengthHours * hour).toISOString(),
    runs: [[start, start + 60_000, 80]],
  });
  const [card] = burndownCards({}, [
    series("Weekly limit", 168, "Gemini models"),
    series("5h limit", 5, "Gemini models"),
    series("Weekly limit", 168, "Claude and GPT models"),
    series("5h limit", 5, "Claude and GPT models"),
  ], [], start + 60_000);
  const titles = card!.rows.map((row) => labels(row)[0]);
  expect(titles).toEqual([
    "Gemini models · 5h limit",
    "Gemini models · Weekly limit",
    "Claude and GPT models · 5h limit",
    "Claude and GPT models · Weekly limit",
  ]);
});

test("the right panel shows both Gemini and Claude/GPT graphs for Antigravity, 5-hour first", () => {
  const start = Date.parse("2026-11-23T12:00:00Z");
  const hour = 3_600_000;
  const series = (group: string, label: string, lengthHours: number) => ({
    provider: "antigravity", group, label, length: lengthHours * hour, start,
    end: start + lengthHours * hour, left: 70, reset: new Date(start + lengthHours * hour).toISOString(),
    runs: [[start, start + 60_000, 70]],
  });
  const history = {
    burndowns: [
      series("Gemini models", "Weekly limit", 168),
      series("Gemini models", "5h limit", 5),
      series("Claude and GPT models", "Weekly limit", 168),
      series("Claude and GPT models", "5h limit", 5),
    ],
    modelUsage: [],
  };
  const windows = panelWindows(history, "antigravity");
  expect(windows.map((w) => `${w.group} · ${w.label}`)).toEqual([
    "Gemini models · 5h limit",
    "Gemini models · Weekly limit",
    "Claude and GPT models · 5h limit",
    "Claude and GPT models · Weekly limit",
  ]);
  const noop = () => {};
  const rendered = labels(rightPanel({}, {
    provider: "antigravity", report: null, pinned: null, focused: true, history, historyError: "",
    details: noop, close: noop, togglePin: noop,
  })).join("\n");
  expect(rendered).toContain("Gemini models · 5h limit");
  expect(rendered).toContain("Gemini models · Weekly limit");
  expect(rendered).toContain("Claude and GPT models · 5h limit");
  expect(rendered).toContain("Claude and GPT models · Weekly limit");
});

test("the right panel shows only the selected provider's allowances and freshness", () => {
  const now = Date.now();
  const reset = new Date(now + 60 * 60_000).toISOString();
  const report = {
    timestamp: now,
    read_at: { claude: now - 3_600_000, codex: now },
    claude: { windows: [{ label: "5h session", used_percent: 94, resets_at: reset }] },
    codex: { resets: { available: 2, items: [{ title: "Full limit reset", expires_at: reset }] } },
    antigravity: { groups: [{ name: "Gemini models", buckets: [{ label: "Weekly", remaining_percent: 60 }] }] },
    others: [{ id: "cursor", problem: "expired" }],
  };
  const noop = () => {};
  const render = (provider: string | null) => labels(rightPanel({}, {
    provider, report, pinned: null, focused: Boolean(provider), history: null, historyError: "",
    details: noop, close: noop, togglePin: noop,
  })).join("\n");

  expect(render(null)).not.toContain("Allowances");
  const claude = render("claude");
  expect(claude).toContain("Allowances");
  expect(claude).toContain("6% left");
  expect(claude).toContain("Resets in");
  expect(claude).toContain("Tight");
  expect(claude).toContain("Sampled 1h ago");
  expect(claude).not.toMatch(/Reset credits|Gemini models|Sign-in expired/);

  const codex = render("codex");
  expect(codex).toContain("Reset credits · 2 available");
  expect(codex).toContain("Expires in");
  expect(codex).toContain("Sampled just now");
  expect(codex).not.toMatch(/6% left|Gemini models|Sign-in expired/);
  expect(render("antigravity")).toContain("Gemini models");
  expect(render("cursor")).toContain("Sign-in expired");
});
