import { expect, mock, test } from "bun:test";

function element() {
  const node = {
    name: "",
    cardContent: null as unknown,
    openDelay: null as number | null,
    closeDelay: null as number | null,
    items: [] as unknown[],
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
      return typeof key === "string" && !(key in target) ? () => receiver : Reflect.get(target, key, receiver);
    },
  });
}

mock.module("gpui-kit", () => ({ div: element }));
mock.module("gpui-base", () => ({
  h_flex: element,
  v_flex: element,
  HoverCard: { new: (id: string) => element().id(id) },
}));
const { burndownCards } = await import("./herdr-app/mods/usage-monitor/burndown.js");

type Element = ReturnType<typeof element>;

function hoverCards(node: unknown): Element[] {
  if (!node || typeof node !== "object") return [];
  const el = node as Element;
  return el.cardContent ? [el] : el.items.flatMap(hoverCards);
}

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
