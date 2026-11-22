// Burndown charts: % left over each 5-hour and weekly window, from the local history.
//
// GPUI has no paths, so the chart is boxes: a step line of 2px bars with a faint fill under it,
// a dotted diagonal for an even pace from 100% at the window's start to 0% at its reset, and a
// row of invisible columns that show the reading under the pointer.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { light, lightColor } from "./pace.js";
import { localTime, timed } from "./time.js";

const NAMES = {
  claude: "Claude", codex: "Codex", antigravity: "Antigravity",
  copilot: "GitHub Copilot", cursor: "Cursor", grok: "Grok", opencode: "OpenCode",
};

const PLOT = 88;
const GUTTER = 34;
const PACE_DOTS = 40;
const COLUMNS = 48;
// Narrowest a run is drawn, in % of the width, so a single reading still shows.
const MIN_RUN = 0.4;

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

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

function plot(t, b, id, now) {
  const { x, y } = scale(b);
  const line = t.accent;
  const marks = [];
  for (const level of [0, 50, 100]) {
    marks.push(div().absolute().left(0).w_full().h(1).top(Math.min(PLOT - 1, y(level))).bg(t.border));
  }
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
  if (now < b.end) {
    marks.push(div().absolute().left(`${x(now)}%`).top(0).h(PLOT).w(1).bg(t.muted).opacity(0.6));
  }
  const span = b.end - b.start;
  for (let i = 0; i < COLUMNS; i += 1) {
    const middle = b.start + ((i + 0.5) / COLUMNS) * span;
    if (middle > now) break;
    marks.push(div().id(`${id}-at-${i}`).absolute().top(0).h(PLOT)
      .left(`${(i / COLUMNS) * 100}%`).w(`${100 / COLUMNS}%`).tooltip(readingAt(b, middle)));
  }
  return div().relative().flex_1().min_w(0).h(PLOT).children(marks)
    .when(b.runs.length === 0, (el) => el.child(div().absolute().top(PLOT / 2 - 16).left(0).w_full()
      .flex().justify_center().text_size(11).text_color(t.muted).child("No readings in this window yet")));
}

function chart(t, b, id, now) {
  const lit = light({ remaining: b.left, resetsAt: b.reset, length: b.length, now });
  const color = lit.level ? lightColor(t, lit.level) : t.foreground;
  const title = [b.group, b.label].filter(Boolean).join(" · ");
  const end = b.reset && Number.isFinite(Date.parse(b.reset)) ? `Resets ${localTime(b.end)}` : "Now";
  const caption = timed("Resets", b.reset) || "No window running: it starts with the next request";
  return v_flex().gap(6).py(6)
    .child(h_flex().justify_between().gap(12)
      .child(h_flex().min_w(0).gap(6).items_center()
        .when(Boolean(lit.level), (el) => el.child(div().flex_none().size(8).rounded_full().bg(color)))
        .child(div().min_w(0).truncate().text_color(t.foreground).child(title)))
      .child(div().flex_none().font_semibold().text_color(color).child(`${Math.round(b.left)}% left`)))
    .child(div().text_size(11).text_color(t.muted).child(caption))
    .child(h_flex().items_start()
      .child(v_flex().flex_none().w(GUTTER).h(PLOT).justify_between().text_size(10).text_color(t.muted)
        .children(["100%", "50%", "0%"].map((label) => div().mt(-6).child(label))))
      .child(plot(t, b, id, now)))
    .child(h_flex().ml(GUTTER).justify_between().text_size(10).text_color(t.muted)
      .child(localTime(b.start)).child(end));
}

/** Cards for the breakdown's columns: one per provider, a chart per 5-hour and weekly limit. */
export function burndownCards(t, burndowns, now = Date.now()) {
  const byProvider = new Map();
  for (const b of burndowns ?? []) {
    if (!byProvider.has(b.provider)) byProvider.set(b.provider, []);
    byProvider.get(b.provider).push(b);
  }
  return [...byProvider].map(([provider, list]) => ({
    title: NAMES[provider] ?? provider,
    rows: list.map((b, i) => chart(t, b, `burndown-${provider}-${i}`, now)),
    weight: list.length * 6,
  }));
}
