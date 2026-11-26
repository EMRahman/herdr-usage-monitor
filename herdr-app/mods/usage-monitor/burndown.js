// Burndown charts: % left over each 5-hour and weekly window, from the local history.
//
// The chart uses a step line of 2px bars with a faint fill under it and a dot at the last reading,
// a dotted diagonal for an even pace from 100% at the window's start to 0% at its reset, a band
// between the two that shades how far ahead or behind that pace each reading was, a faint tint
// over the time already gone, and a row of invisible columns that show the reading and model
// activity under the pointer.
import { div, svg } from "gpui-kit";
import { h_flex, HoverCard, v_flex } from "gpui-base";
import { MARGIN, RESET_COLOR, light, lightColor } from "./pace.js";
import { duration, localTime, timed } from "./time.js";

export const PROVIDER_NAMES = {
  claude: "Claude", codex: "Codex", antigravity: "Antigravity",
  copilot: "GitHub Copilot", cursor: "Cursor", grok: "Grok", opencode: "OpenCode",
};

const ORDER = ["claude", "codex", "antigravity"];

const PLOT = 88;
const GUTTER = 34;
const PACE_DOTS = 40;
const COLUMNS = 48;
// Narrowest a run is drawn, in % of the width, so a single reading still shows.
const MIN_RUN = 0.4;
const BAND_OPACITY = 0.22;

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

function resetMark(t, dim = false, size = 10) {
  return svg("mods/usage-monitor/reset.svg").size(size).flex_none().text_color(dim ? t.muted : RESET_COLOR);
}

// Held resets beneath a provider's charts, styled like the rows beneath the bars in Allowances.
export function resetRows(t, held, provider, compact = false) {
  const mine = (held ?? []).filter((entry) => entry.provider === provider);
  if (!mine.length) return [];
  const available = mine.reduce((sum, entry) => sum + (entry.count ?? 1), 0);
  const heading = provider === "claude" ? `Limit resets · ${available} available`
    : `Reset credits · ${available} available`;
  const expiryText = (entry) => Number.isFinite(entry.msLeft)
    ? `Expires in ${duration(entry.msLeft)}${entry.expiresAt ? ` · ${localTime(entry.expiresAt)}` : ""}`
    : timed("Expires", entry.expiresAt);
  const itemRow = (entry) => {
    const use = provider === "claude"
      ? (entry.status ?? (entry.needsLimit ? "Run /limit-reset at a limit to use it" : "Run /limit-reset to use it"))
      : (entry.status ?? "");
    const caption = [expiryText(entry), use].filter(Boolean).join(" · ");
    const amount = entry.total > 1 ? `${entry.count} of ${entry.total} left` : "";
    const color = entry.urgent ? RESET_COLOR : t.foreground;
    return v_flex().gap(compact ? 2 : 5).py(compact ? 3 : 5)
      .child(h_flex().justify_between().gap(12)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(resetMark(t, !entry.usable))
          .child(div().min_w(0).text_color(t.foreground)
            .when(compact, (el) => el.truncate().tooltip(entry.label)).child(entry.label)))
        .when(Boolean(amount), (el) => el.child(div().flex_none().font_semibold().text_color(color).child(amount))))
      .when(Boolean(caption), (el) => el.child(div().min_w(0).text_size(11).text_color(t.muted)
        .when(compact, (c) => c.truncate().tooltip(caption)).child(caption)));
  };
  return [
    div().mt(4).font_semibold().child(heading),
    ...mine.map(itemRow),
  ];
}

function scale(b) {
  const span = b.end - b.start;
  return {
    x: (time) => clamp(((time - b.start) / span) * 100, 0, 100),
    y: (left) => (1 - clamp(left, 0, 100) / 100) * PLOT,
  };
}

const pace = (b, time) => clamp(100 - ((time - b.start) / (b.end - b.start)) * 100, 0, 100);

// What the pointer shows over one column: the reading at its middle, against an even pace.
function readingAt(b, time) {
  const run = b.runs.find(([from, to]) => from <= time && time <= to);
  if (!run) return `${localTime(time)} · no reading`;
  return `${localTime(time)} · ${Math.round(run[2])}% left · even pace ${Math.round(pace(b, time))}%`;
}

function hoverColumns(t, b, activity, id, now, selectPrompts) {
  const through = Math.min(now, b.end);
  const span = b.end - b.start;
  if (span <= 0 || through <= b.start) return [];

  const slice = span / COLUMNS;
  const count = Math.min(COLUMNS, Math.ceil((through - b.start) / slice));
  const labels = Array.from({ length: count }, () => new Set());
  for (const { at, model, effort } of activity) {
    if (at < b.start || at > through) continue;
    const index = Math.min(count - 1, Math.floor((at - b.start) / slice));
    labels[index].add(`${model} · ${effort ? `${effort} effort` : "effort unavailable"}`);
  }

  return labels.map((models, i) => {
    const from = b.start + i * slice;
    const to = Math.min(from + slice, through);
    const time = to === now ? now : (from + to) / 2;
    const tip = v_flex().gap(3).max_w(320).px(9).py(7).rounded(6)
      .border_1().border_color(t.border).bg(t.popover).shadow_sm()
      .text_size(11).text_color(t.foreground).child(readingAt(b, time));
    if (models.size) {
      const first = localTime(from);
      const last = localTime(to);
      const range = first === last ? first : `${first}–${last}`;
      tip.child(div().text_color(t.muted).child(`Local activity · ${range}`)).children(models);
    }
    const trigger = div().w_full().h(PLOT);
    if (selectPrompts) {
      tip.child(div().text_color(t.muted).child("Click for Codex prompts in this interval"));
      trigger.id(`${id}-prompts-${i}`).cursor_pointer().on_click((_event, cx) => selectPrompts({
        mode: "burndown", from, to, label: `${localTime(from)} – ${localTime(to)}`,
      }, cx));
    }
    return div().absolute().top(0).h(PLOT)
      .left(`${(i / COLUMNS) * 100}%`).w(`${((to - from) / span) * 100}%`)
      .child(HoverCard.new(`${id}-at-${i}`).open_delay(0).close_delay(0)
        .trigger(trigger).content(tip));
  });
}

// The gap between each reading and an even pace, shaded: green ahead of it, yellow a little
// behind, red MARGIN or more points behind. Each run is cut at the hover columns' edges and
// measured against the pace at each piece's middle, so the band steps down beside the dots.
function gapBand(t, b, x, y) {
  const span = b.end - b.start;
  if (span <= 0) return [];
  const slice = span / COLUMNS;
  const boxes = [];
  for (const [from, to, left] of b.runs) {
    for (let i = Math.floor((from - b.start) / slice); b.start + i * slice < to; i += 1) {
      const a = Math.max(from, b.start + i * slice);
      const z = Math.min(to, b.start + (i + 1) * slice);
      if (z <= a) continue;
      const even = pace(b, (a + z) / 2);
      const top = y(Math.max(left, even));
      const height = y(Math.min(left, even)) - top;
      if (height < 1) continue;
      const spare = left - even;
      const level = spare >= 0 ? "untapped" : spare > -MARGIN ? "pace" : "tight";
      boxes.push(div().absolute().left(`${x(a)}%`).w(`${x(z) - x(a)}%`).top(top).h(height)
        .bg(lightColor(t, level)).opacity(BAND_OPACITY));
    }
  }
  return boxes;
}

function plot(t, b, activity, id, now, selectPrompts) {
  const { x, y } = scale(b);
  const line = t.accent;
  const marks = [];
  if (now > b.start && now < b.end) {
    // A faint tint over the time already gone, so how far through the window we are reads at a glance.
    marks.push(div().absolute().left(0).top(0).h(PLOT).w(`${x(now)}%`).bg(t.foreground).opacity(0.035));
  }
  for (const level of [0, 50, 100]) {
    marks.push(div().absolute().left(0).w_full().h(1).top(Math.min(PLOT - 1, y(level))).bg(t.border));
  }
  marks.push(...gapBand(t, b, x, y));
  for (let i = 0; i <= PACE_DOTS; i += 1) {
    const share = i / PACE_DOTS;
    marks.push(div().absolute().size(2).rounded_full().bg(t.muted)
      .left(`${Math.min(99.6, share * 100)}%`).top(clamp(share * PLOT - 1, 0, PLOT - 2)));
  }
  b.runs.forEach(([from, to, left], i) => {
    const x1 = x(from);
    const width = Math.max(MIN_RUN, x(to) - x1);
    const top = y(left);
    marks.push(div().absolute().left(`${x1}%`).w(`${width}%`).top(top).h(PLOT - top).bg(line).opacity(0.14));
    marks.push(div().absolute().left(`${x1}%`).w(`${width}%`).top(clamp(top - 1, 0, PLOT - 2)).h(2).bg(line));
    const prev = b.runs[i - 1];
    if (prev && prev[1] === from && prev[2] !== left) {
      const a = y(prev[2]);
      marks.push(div().absolute().left(`${x1}%`).w(2).top(clamp(Math.min(a, top) - 1, 0, PLOT))
        .h(Math.abs(a - top) + 2).bg(line));
    }
  });
  const last = b.runs.at(-1);
  if (last) {
    const [, to, left] = last;
    marks.push(div().absolute().size(5).rounded_full().bg(line)
      .left(`${x(to)}%`).ml(-2.5).top(clamp(y(left), 1, PLOT - 1) - 2.5));
  }
  marks.push(...hoverColumns(t, b, activity, id, now, selectPrompts));
  return div().relative().flex_1().min_w(0).h(PLOT).children(marks)
    .when(b.runs.length === 0, (el) => el.child(div().absolute().top(PLOT / 2 - 16).left(0).w_full()
      .flex().justify_center().text_size(11).text_color(t.muted).child("No readings in this window yet")));
}

export function burndownChart(t, b, activity, id, now, compact = false, selectPrompts) {
  const lit = light({ remaining: b.left, resetsAt: b.reset, length: b.length, now });
  const color = lit.level ? lightColor(t, lit.level) : t.foreground;
  const title = [b.accountLabel, b.group, b.label].filter(Boolean).join(" · ");
  const hasReset = Boolean(b.reset && Number.isFinite(Date.parse(b.reset)));
  const unstarted = !hasReset && b.end > now;
  const startLabel = unstarted ? "Now" : localTime(b.start);
  const end = hasReset ? `Resets ${localTime(b.end)}` : unstarted ? localTime(b.end) : "Now";
  const caption = timed("Resets", b.reset) || "No window running: it starts with the next request";
  const summary = compact && lit.msLeft > 0 ? `Resets in ${duration(lit.msLeft)}` : caption;
  return v_flex().gap(6).py(6)
    .child(h_flex().justify_between().gap(12)
      .child(h_flex().min_w(0).gap(6).items_center()
        .when(Boolean(lit.level), (el) => el.child(div().flex_none().size(8).rounded_full().bg(color)))
        .child(div().min_w(0).truncate().text_color(t.foreground)
          .when(compact, (el) => el.tooltip(title)).child(title)))
      .child(div().flex_none().font_semibold().text_color(color).child(`${Math.round(b.left)}% left`)))
    .child(div().text_size(11).text_color(t.muted)
      .when(compact, (el) => el.truncate().tooltip(caption))
      .child(compact && lit.level === "tight" ? `Tight · ${summary}` : summary))
    .child(h_flex().items_start()
      .child(v_flex().flex_none().w(GUTTER).h(PLOT).justify_between().text_size(10).text_color(t.muted)
        .children(["100%", "50%", "0%"].map((label) => div().mt(-6).child(label))))
      .child(plot(t, b, activityForChart(b, activity), id, now, selectPrompts)))
    .child(h_flex().ml(GUTTER).justify_between().text_size(10).text_color(t.muted)
      .child(compact && !unstarted ? "Start" : startLabel)
      .child(compact && hasReset ? "Reset" : end));
}

function activityForChart(b, activity) {
  if (b.provider !== "antigravity" || !b.group) return activity;

  const words = (name) => name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const group = words(b.group);
  if (group[0] === "gemini" && /^\d/.test(group[1] ?? "")) {
    // A quota can cover a single Gemini model, including variants with a suffix in the log.
    const modelName = `-${group.join("-")}-`;
    return activity.filter(({ model }) => `-${words(model).join("-")}-`.includes(modelName));
  }

  const families = group.filter((word) => word === "gemini" || word === "claude" || word === "gpt");
  if (!families.length) return activity;
  return activity.filter(({ model }) => {
    const modelWords = words(model);
    return families.some((family) => modelWords.includes(family));
  });
}

/** Cards for the breakdown's columns: one per provider, a chart per 5-hour and weekly limit. */
export function burndownCards(t, burndowns, modelUsage = [], now = Date.now(), held = [], selectPrompts) {
  // The Allowances view's order: Claude, Codex, Antigravity, then the rest; within a provider,
  // each account and model group together, 5-hour before weekly.
  const first = (list, key) => {
    const seen = new Map();
    for (const b of list) if (!seen.has(key(b))) seen.set(key(b), seen.size);
    return (b) => seen.get(key(b));
  };
  const list = burndowns ?? [];
  const providerAt = first(list, (b) => b.provider);
  const groupAt = first(list, (b) => `${b.account ?? ""}\u0000${b.group ?? ""}`);
  const rank = (b) => { const i = ORDER.indexOf(b.provider); return i < 0 ? ORDER.length + providerAt(b) : i; };
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || groupAt(a) - groupAt(b) || a.length - b.length);
  const byProvider = new Map();
  for (const b of sorted) {
    if (!byProvider.has(b.provider)) byProvider.set(b.provider, []);
    byProvider.get(b.provider).push(b);
  }
  const activityByProvider = new Map();
  for (const event of modelUsage) {
    if (!activityByProvider.has(event.provider)) activityByProvider.set(event.provider, []);
    activityByProvider.get(event.provider).push(event);
  }
  return [...byProvider].map(([provider, list]) => {
    const activity = activityByProvider.get(provider) ?? [];
    const charts = list.map((b, i) => burndownChart(t, b, activity, `burndown-${provider}-${i}`, now, false,
      provider === "codex" ? selectPrompts : undefined));
    const resets = resetRows(t, held, provider);
    return {
      provider,
      title: PROVIDER_NAMES[provider] ?? provider,
      rows: [...charts, ...resets],
      weight: list.length * 6 + resets.length,
    };
  });
}
