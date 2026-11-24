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
const { burndownCards } = await import("./herdr-app/mods/usage-monitor/burndown.js");

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
