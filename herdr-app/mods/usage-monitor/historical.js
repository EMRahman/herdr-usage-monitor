// Historical panel: model & token usage across D / W / M / Y horizons with both
// a stacked bar chart and a native GPUI PathBuilder line graph over time.
import { Background, PathBuilder, div } from "gpui-kit";
import { Button, HoverCard, Popover, h_flex, v_flex } from "gpui-base";
import { formatCompact, formatInt } from "./time.js";

// Oceanic Steel categorical model palette: cool blues/teals with muted warm accents,
// legible on both dark and light Herdr themes.
export const MODEL_COLORS = [
  "#3b82f6",
  "#14b8a6",
  "#d9a21b",
  "#38bdf8",
  "#2da866",
  "#ea7a2e",
  "#818cf8",
];
export const OTHER_COLOR = "#52525b";

const TREND_UP = "#2fbf71";
const TREND_DOWN = "#e5534b";

const PROVIDER_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi",
};

const HORIZONS = [
  { key: "d", label: "D", tip: "Day (hourly) · D" },
  { key: "w", label: "W", tip: "Week (daily) · W" },
  { key: "m", label: "M", tip: "Month (daily) · M" },
  { key: "y", label: "Y", tip: "Year (52 weeks) · Y" },
];

const CHART_MODES = [
  { key: "both", label: "Both" },
  { key: "bars", label: "Bars" },
  { key: "line", label: "Line" },
];

const LINE_MODES = [
  { key: "models", label: "Per model" },
  { key: "cumulative", label: "Cumulative" },
];

export const DEFAULT_CHART_PREFS = {
  horizon: "m",
  chartMode: "both",
  lineMode: "models",
  includeCache: true,
  providerFilter: "all",
  modelFilter: "all",
};

const VALID_HORIZONS = new Set(["d", "w", "m", "y"]);
const VALID_CHART_MODES = new Set(["both", "bars", "line"]);
const VALID_LINE_MODES = new Set(["models", "cumulative"]);

/** Validates persisted chart selections, falling back cleanly to defaults. */
export function normalizeChartPrefs(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ...DEFAULT_CHART_PREFS };
  }
  const cleanFilter = (value) =>
    typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : "all";
  return {
    horizon: VALID_HORIZONS.has(obj.horizon) ? obj.horizon : DEFAULT_CHART_PREFS.horizon,
    chartMode: VALID_CHART_MODES.has(obj.chartMode) ? obj.chartMode : DEFAULT_CHART_PREFS.chartMode,
    lineMode: VALID_LINE_MODES.has(obj.lineMode) ? obj.lineMode : DEFAULT_CHART_PREFS.lineMode,
    includeCache: typeof obj.includeCache === "boolean" ? obj.includeCache : DEFAULT_CHART_PREFS.includeCache,
    providerFilter: cleanFilter(obj.providerFilter),
    modelFilter: cleanFilter(obj.modelFilter),
  };
}

const GUTTER = 44;
const PLOT_BOTH = 148;
const PLOT_SINGLE = 216;
const HOVER_TINT = "#8080801c";
const FUTURE_TINT = "#8080800d";

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

export function modelColor(name, index) {
  if (name === "Other") return OTHER_COLOR;
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

/** Rounds a positive maximum up to a crisp axis tick ceiling (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 × 10^k). */
export function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const norm = value / base;
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const step = steps.find((candidate) => norm <= candidate) ?? 10;
  return step * base;
}

/** Period offset (<= 0) that places `targetMs` inside the given local calendar horizon. */
export function offsetForTimestamp(horizon, targetMs, now = Date.now()) {
  if (!Number.isFinite(targetMs)) return 0;
  const cur = new Date(now);
  const tgt = new Date(targetMs);
  if (horizon === "y") return Math.min(0, tgt.getFullYear() - cur.getFullYear());
  if (horizon === "m") {
    return Math.min(0, (tgt.getFullYear() - cur.getFullYear()) * 12 + (tgt.getMonth() - cur.getMonth()));
  }
  const curMid = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), 12, 0, 0, 0);
  const tgtMid = new Date(tgt.getFullYear(), tgt.getMonth(), tgt.getDate(), 12, 0, 0, 0);
  if (horizon === "d") {
    return Math.min(0, Math.round((tgtMid.getTime() - curMid.getTime()) / 86_400_000));
  }
  // Week: Monday-anchored local week difference.
  const curDow = (curMid.getDay() + 6) % 7;
  const tgtDow = (tgtMid.getDay() + 6) % 7;
  const curMon = new Date(curMid.getFullYear(), curMid.getMonth(), curMid.getDate() - curDow, 12, 0, 0, 0);
  const tgtMon = new Date(tgtMid.getFullYear(), tgtMid.getMonth(), tgtMid.getDate() - tgtDow, 12, 0, 0, 0);
  return Math.min(0, Math.round((tgtMon.getTime() - curMon.getTime()) / (7 * 86_400_000)));
}

function keyHint(t, key) {
  return div().text_size(10).text_color(t.dim).child(key);
}

function providerName(id) {
  return PROVIDER_NAMES[id] ?? id;
}

function deltaBadge(t, deltaKind, deltaPct, prevTokens) {
  if (!deltaKind || deltaKind === "none") return null;
  let text = "0%";
  let color = t.dim;
  if (deltaKind === "new") {
    text = "New";
    color = t.accent;
  } else if (deltaKind === "up") {
    text = `↑+${Number(deltaPct).toFixed(1)}%`;
    color = TREND_UP;
  } else if (deltaKind === "down") {
    text = `↓${Number(deltaPct).toFixed(1)}%`;
    color = TREND_DOWN;
  }
  const tip = prevTokens != null ? `Previous period: ${formatInt(prevTokens)} tokens` : "Previous period comparison";
  return div().flex_none().text_size(11).font_medium().text_color(color).tooltip(tip).child(text);
}

function surfaceCard(t, children, gap = 10) {
  return v_flex().w_full().min_w(0).gap(gap).p(12).rounded(8)
    .bg(t.surface).border(1).border_color(t.border)
    .children(children);
}

function segmentedPill(t, id, items, activeKey, onPick, hint = "") {
  const pill = h_flex().id(id).gap(2).p(2).rounded(6).bg(t.raised)
    .children(items.map((item) => {
      const selected = item.key === activeKey;
      const el = div().id(`${id}-${item.key}`).h(24).px(8).rounded(4).flex().items_center().text_size(11);
      return (selected
        ? el.bg(t.selected).text_color(t.foreground).font_semibold()
        : el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
            .on_click((_event, cx) => onPick(item.key, cx)))
        .when(Boolean(item.tip), (node) => node.tooltip(item.tip))
        .child(item.label);
    }));
  return hint ? h_flex().gap(5).items_center().child(pill).child(keyHint(t, hint)) : pill;
}

function filterMenu(t, field, label, selectedValue, options, openFilter, onOpenChange, onPick) {
  const id = `hist-filter-${field}`;
  const isOpen = openFilter === id;
  const active = selectedValue !== "all";
  const current = options.find((opt) => opt.value === selectedValue);
  const display = active ? (current?.label ?? selectedValue) : "All";

  const trigger = Button.new(`${id}-trigger`).h(28).px(8).gap(6).items_center().rounded(5)
    .bg(t.raised).border(1).border_color(active ? t.accent : t.border).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .accessibility_label(`${label}: ${display}`)
    .child(div().text_size(10).text_color(t.dim).child(label))
    .child(div().max_w(130).truncate().text_size(11).text_color(t.foreground).child(display))
    .child(div().text_size(10).text_color(t.dim).child("⌄"));

  const menu = Popover.new(id).trigger(trigger).open(isOpen)
    .on_open_change((open, cx) => onOpenChange(open ? id : null, cx));

  if (isOpen) {
    const allOptions = [{ value: "all", label: `All ${label.toLowerCase()}s`, meta: "" }, ...options];
    menu.content(
      v_flex().w(240).max_h(300).overflow_y_scrollbar().p(4).gap(2).rounded(8)
        .bg(t.popover).border(1).border_color(t.border).shadow_sm()
        .children(allOptions.map((opt, index) => {
          const isSelected = opt.value === selectedValue;
          return Button.new(`${id}-opt-${index}`).w_full().h(26).px(8).gap(6).items_center().rounded(4)
            .cursor_pointer()
            .when(isSelected, (el) => el.bg(t.selected))
            .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_event, cx) => {
              onOpenChange(null, cx);
              onPick(opt.value, cx);
            })
            .child(div().w(12).text_size(10).text_color(t.accent).child(isSelected ? "✓" : ""))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground)
              .tooltip(opt.tooltip || opt.label).child(opt.label))
            .when(Boolean(opt.meta), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(opt.meta)));
        })),
    );
  }
  return menu;
}

function controlsBar(t, data, state) {
  const hasFilters = state.providerFilter !== "all" || state.modelFilter !== "all";
  const rangeLabel = data?.range?.label ?? "Loading…";
  const canStepForward = Boolean(data?.range?.hasNext);

  const providerOptions = (data?.facets?.providers ?? []).map((p) => ({
    value: p.value,
    label: p.label,
    meta: p.tokens > 0 ? formatCompact(p.tokens) : "0",
    tooltip: `${p.label} · ${formatInt(p.tokens)} tokens · ${formatInt(p.sessions)} sessions`,
  }));
  const modelOptions = (data?.facets?.models ?? []).map((m) => ({
    value: m.value,
    label: m.value,
    meta: m.tokens > 0 ? formatCompact(m.tokens) : "0",
    tooltip: `${m.value} · ${formatInt(m.tokens)} tokens · ${formatInt(m.sessions)} sessions`,
  }));

  const stepBtn = (id, glyph, tip, disabled, onClick) => {
    const el = div().id(id).h(28).w(26).rounded(5).flex().items_center().justify_center()
      .bg(t.raised).tooltip(tip);
    if (disabled) return el.text_color(t.dim).opacity(0.45).child(glyph);
    return el.text_color(t.foreground).hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_click(onClick).child(glyph);
  };

  const cacheBtn = div().id("hist-cache-toggle").h(28).px(8).gap(6).rounded(5).flex().items_center()
    .bg(t.raised).border(1).border_color(state.includeCache ? t.border : t.accent).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip("Toggle prompt cache read & write tokens in totals (C)")
    .on_click((_event, cx) => state.toggleCache(cx))
    .child(div().text_size(11).text_color(state.includeCache ? t.foreground : t.accent)
      .child(state.includeCache ? "Cache: On" : "Cache: Off"))
    .child(keyHint(t, "C"));

  return h_flex().w_full().flex_wrap().justify_between().items_center().gap(8)
    .child(h_flex().flex_wrap().items_center().gap(8)
      .child(segmentedPill(t, "hist-horizon", HORIZONS, state.horizon, state.setHorizon))
      .child(h_flex().items_center().gap(4)
        .child(stepBtn("hist-step-prev", "‹", "Previous period ([)", false, (_e, cx) => state.stepOffset(-1, cx)))
        .child(div().min_w(116).px(6).text_center().text_size(12).font_semibold()
          .text_color(t.foreground).child(rangeLabel))
        .child(stepBtn("hist-step-next", "›", "Next period (])", !canStepForward, (_e, cx) => state.stepOffset(1, cx)))
        .when(state.offset < 0, (el) => el.child(div().id("hist-step-now").h(28).px(8).gap(5).rounded(5)
          .flex().items_center().bg(t.raised).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => state.resetOffset(cx))
          .child("Current").child(keyHint(t, "T")))))
      .child(filterMenu(t, "provider", "Provider", state.providerFilter, providerOptions,
        state.openFilter, state.setOpenFilter, state.setProviderFilter))
      .child(filterMenu(t, "model", "Model", state.modelFilter, modelOptions,
        state.openFilter, state.setOpenFilter, state.setModelFilter))
      .when(hasFilters, (el) => el.child(div().id("hist-clear-filters").h(28).px(8).rounded(5)
        .flex().items_center().text_size(11).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => state.clearFilters(cx))
        .child("Clear filters"))))
    .child(h_flex().flex_wrap().items_center().gap(8)
      .child(cacheBtn)
      .child(segmentedPill(t, "hist-chart-mode", CHART_MODES, state.chartMode, state.setChartMode, "G")));
}

function kpiStrip(t, data, colors, width) {
  const s = data.summary;
  const totalTip = [
    `${formatInt(s.totalTokens)} tokens (${data.includeCache ? "cache included" : "cache excluded"})`,
    s.prevTotalTokens != null ? `Previous period: ${formatInt(s.prevTotalTokens)}` : "",
    `${formatInt(s.events)} calls · ${formatInt(s.sessions)} sessions`,
  ].filter(Boolean).join(" · ");

  const ioTip = [
    `Input (uncached): ${formatInt(s.inputTokens)}`,
    `Output: ${formatInt(s.outputTokens)}`,
    s.reasoningTokens > 0 ? `Reasoning (inside output): ${formatInt(s.reasoningTokens)}` : "",
    `Cache read: ${formatInt(s.cacheReadTokens)}`,
    s.cacheWriteTokens > 0 ? `Cache write: ${formatInt(s.cacheWriteTokens)}` : "",
  ].filter(Boolean).join(" · ");

  const cacheTip = s.cacheHitRate != null
    ? `${formatInt(s.cacheReadTokens)} cache reads of ${formatInt(s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens)} input-side tokens`
    : "No input tokens in this period";

  const top = s.topModel;
  const topColor = top ? (colors.get(top.model) ?? OTHER_COLOR) : null;
  const peak = s.peakBucket;

  const items = [
    {
      label: "TOTAL TOKENS",
      value: formatCompact(s.totalTokens),
      badge: deltaBadge(t, s.deltaKind, s.deltaPct, s.prevTotalTokens),
      note: data.includeCache ? "cache included" : "cache excluded",
      tooltip: totalTip,
    },
    {
      label: "INPUT / OUTPUT",
      value: `${formatCompact(s.inputTokens)} / ${formatCompact(s.outputTokens)}`,
      note: s.reasoningTokens > 0
        ? `${formatCompact(s.reasoningTokens)} reasoning in out`
        : `${formatInt(s.events)} calls`,
      tooltip: ioTip,
    },
    {
      label: "CACHE HIT RATE",
      value: s.cacheHitRate != null ? `${s.cacheHitRate}%` : "—",
      note: s.cacheReadTokens > 0
        ? `${formatCompact(s.cacheReadTokens)} read${s.cacheWriteTokens > 0 ? ` · ${formatCompact(s.cacheWriteTokens)} write` : ""}`
        : "No cache reads",
      tooltip: cacheTip,
    },
    {
      label: "TOP MODEL",
      dot: topColor,
      value: top ? top.model : "—",
      smallValue: true,
      note: top ? `${top.sharePct}% · ${formatCompact(top.tokens)}` : "No activity",
      tooltip: top ? `${top.model} (${providerName(top.provider)}) · ${formatInt(top.tokens)} tokens (${top.sharePct}%)` : "No model usage",
    },
    {
      label: "PEAK & VOLUME",
      value: peak ? formatCompact(peak.tokens) : "—",
      note: peak ? `${peak.label} · ${formatInt(s.sessions)} sess` : `${formatInt(s.sessions)} sessions`,
      tooltip: peak
        ? `Peak: ${formatInt(peak.tokens)} tokens (${peak.label}) · ${formatInt(s.sessions)} sessions · ${formatInt(s.events)} calls`
        : "No activity in this period",
    },
  ];

  const cell = (item, divided) => v_flex().flex_1().min_w(0).gap(3)
    .when(divided, (el) => el.border_l(1).border_color(t.border).pl(12))
    .child(div().text_size(9.5).font_semibold().text_color(t.dim).child(item.label))
    .child(h_flex().items_center().gap(6).min_w(0)
      .when(Boolean(item.dot), (el) => el.child(div().flex_none().size(8).rounded_full().bg(item.dot)))
      .child(div().min_w(0).truncate().font_semibold()
        .text_size(item.smallValue ? 14 : 18)
        .text_color(t.foreground).tooltip(item.tooltip).child(item.value))
      .when(Boolean(item.badge), (el) => el.child(item.badge)))
    .child(div().truncate().text_size(10.5).text_color(t.muted).child(item.note));

  const perRow = (width || 1100) >= 880 ? 5 : (width || 1100) >= 580 ? 3 : 2;
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) {
    const slice = items.slice(i, i + perRow);
    rows.push(h_flex().w_full().items_start().gap(12)
      .children(slice.map((item, idx) => cell(item, idx > 0))));
  }
  return surfaceCard(t, rows, 10);
}

function seriesLegend(t, models, colors, activeModel, onPickModel) {
  if (!models.length) return null;
  return h_flex().w_full().flex_wrap().gap(6).items_center()
    .children(models.map((name) => {
      const clickable = name !== "Other";
      const selected = clickable && activeModel === name;
      const chip = h_flex().px(6).py(2).gap(5).items_center().rounded(4)
        .when(selected, (el) => el.bg(t.selected))
        .when(clickable && !selected, (el) => el.hover((s) => s.bg(t.hover)).cursor_pointer())
        .when(clickable, (el) => el.cursor_pointer().on_click((_event, cx) =>
          onPickModel(selected ? "all" : name, cx)))
        .child(div().size(8).flex_none().rounded_full().bg(colors.get(name) ?? OTHER_COLOR))
        .child(div().max_w(190).truncate().text_size(10.5)
          .text_color(selected ? t.foreground : t.muted)
          .tooltip(clickable ? `${name} · click to ${selected ? "clear filter" : "filter"}` : "All remaining models")
          .child(name));
      return chip;
    }));
}

function xAxisLabels(t, buckets) {
  const count = buckets.length;
  if (!count) return div().h(14);
  const marks = [];
  for (let i = 0; i < count; i += 1) {
    const text = buckets[i].axisLabel;
    if (!text) continue;
    const pct = (i / count) * 100;
    const alignRight = pct > 88;
    marks.push(div().absolute().top(0)
      .when(!alignRight, (el) => el.left(`${pct}%`))
      .when(alignRight, (el) => el.right(0))
      .text_size(10).text_color(t.muted).whitespace_nowrap().child(text));
  }
  return div().relative().h(15).ml(GUTTER).children(marks);
}

function yAxisGutter(t, yMax, plotH) {
  const labels = yMax > 0
    ? [formatCompact(yMax), formatCompact(yMax / 2), "0"]
    : ["", "", "0"];
  return v_flex().flex_none().w(GUTTER).h(plotH).justify_between().pr(6).items_end()
    .text_size(10).text_color(t.muted)
    .children(labels.map((text, idx) => div().when(idx === 0, (el) => el.mt(-5))
      .when(idx === 2, (el) => el.mb(-4)).child(text)));
}

function gridLines(t, plotH) {
  return [0, Math.round(plotH / 2), plotH - 1].map((top) =>
    div().absolute().left(0).w_full().h(1).top(top).bg(t.border));
}

function bucketTooltip(t, bucket, models, colors, includeCache, cumulative = false) {
  const valueTotal = cumulative ? bucket.cumulativeTotal : bucket.total;
  const map = cumulative ? bucket.cumulativeByModel : bucket.byModel;
  const rows = [];
  rows.push(div().font_semibold().text_color(t.foreground).child(bucket.label));
  if (bucket.future) {
    rows.push(div().text_color(t.muted).child("Future time slot"));
  } else if (valueTotal === 0) {
    rows.push(div().text_color(t.muted).child("No token usage"));
  } else {
    rows.push(div().text_color(t.foreground).child(
      cumulative
        ? `${formatInt(valueTotal)} cumulative tokens`
        : `${formatInt(valueTotal)} tokens · ${formatInt(bucket.events)} ${bucket.events === 1 ? "call" : "calls"}`,
    ));
    if (!cumulative) {
      const parts = [
        `In ${formatCompact(bucket.input)}`,
        `Out ${formatCompact(bucket.output)}`,
      ];
      if (includeCache && (bucket.cacheRead > 0 || bucket.cacheWrite > 0)) {
        parts.push(`Cache ${formatCompact(bucket.cacheRead + bucket.cacheWrite)}`);
      }
      rows.push(div().text_size(10.5).text_color(t.muted).child(parts.join(" · ")));
    }
    const activeModels = models
      .map((name) => ({ name, tokens: map?.[name] ?? 0 }))
      .filter((entry) => entry.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);
    for (const entry of activeModels) {
      const share = valueTotal > 0 ? Math.round((entry.tokens / valueTotal) * 1000) / 10 : 0;
      rows.push(h_flex().justify_between().items_center().gap(12)
        .child(h_flex().min_w(0).gap(5).items_center()
          .child(div().size(7).flex_none().rounded_full().bg(colors.get(entry.name) ?? OTHER_COLOR))
          .child(div().max_w(170).truncate().text_color(t.foreground).child(entry.name)))
        .child(div().flex_none().text_color(t.muted).child(`${formatCompact(entry.tokens)} (${share}%)`)));
    }
  }
  return v_flex().gap(3).min_w(210).max_w(320).px(9).py(7).rounded(6)
    .border(1).border_color(t.border).bg(t.popover).shadow_sm()
    .text_size(11).children(rows);
}

/** Stacked bar chart card (inspired by herdr-insights, native to usage-monitor). */
export function stackedBarCard(t, data, colors, state) {
  const { buckets, models, maxBucketTotal } = data.series;
  const plotH = state.chartMode === "bars" ? PLOT_SINGLE : PLOT_BOTH;
  const yMax = niceMax(maxBucketTotal);
  const gap = buckets.length > 36 ? 1 : 2;

  const children = [
    h_flex().w_full().flex_wrap().justify_between().items_center().gap(8)
      .child(div().font_semibold().text_size(14).child("Tokens by model"))
      .child(div().text_size(11).text_color(t.muted)
        .child(`${data.range.label} · ${data.range.subtitle} · ${formatCompact(data.summary.totalTokens)} tokens`)),
  ];

  if (yMax === 0) {
    children.push(div().py(24).text_center().text_size(12).text_color(t.muted)
      .child("No token usage recorded in this period."));
  } else {
    const reverseOrder = [...models].reverse();
    const columns = buckets.map((bucket, idx) => {
      const segments = [];
      if (!bucket.future && bucket.total > 0) {
        for (const name of reverseOrder) {
          const tokens = bucket.byModel[name] ?? 0;
          if (tokens > 0) segments.push({ name, tokens });
        }
      }
      const barH = bucket.total > 0
        ? Math.max(2, Math.round((bucket.total / yMax) * plotH))
        : 0;

      const trigger = v_flex().w_full().h(plotH).justify_end()
        .when(bucket.future, (el) => el.bg(FUTURE_TINT))
        .hover((s) => s.bg(HOVER_TINT))
        .when(barH > 0, (el) => el.child(
          v_flex().w_full().flex_none().h(barH).rounded_t(2).overflow_hidden()
            .children(segments.map((seg) =>
              div().w_full().flex_grow(Math.max(0.001, seg.tokens))
                .bg(colors.get(seg.name) ?? OTHER_COLOR))),
        ));

      return div().flex_1().min_w(0).h(plotH).child(
        HoverCard.new(`hist-bar-${data.horizon}-${data.offset}-${idx}`)
          .open_delay(0).close_delay(0)
          .trigger(trigger)
          .content(bucketTooltip(t, bucket, models, colors, data.includeCache, false)),
      );
    });

    children.push(
      h_flex().w_full().items_start()
        .child(yAxisGutter(t, yMax, plotH))
        .child(div().relative().flex_1().min_w(0).h(plotH)
          .children(gridLines(t, plotH))
          .child(h_flex().relative().size_full().gap(gap).items_end().children(columns))),
      xAxisLabels(t, buckets),
    );
    const legend = seriesLegend(t, models, colors, state.modelFilter, state.setModelFilter);
    if (legend) children.push(legend);
  }

  return surfaceCard(t, children, 8);
}

function buildPolylinePath(points, strokeWidth, dash = null) {
  let builder = PathBuilder.stroke(strokeWidth);
  if (dash) builder = builder.dash_array(dash);
  builder = builder.move_to(`${points[0].xPct}%`, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    builder = builder.line_to(`${points[i].xPct}%`, points[i].y);
  }
  return builder.build();
}

function buildAreaPath(points, plotH) {
  let builder = PathBuilder.fill();
  builder = builder.move_to(`${points[0].xPct}%`, plotH);
  for (const pt of points) {
    builder = builder.line_to(`${pt.xPct}%`, pt.y);
  }
  builder = builder.line_to(`${points[points.length - 1].xPct}%`, plotH).close();
  return builder.build();
}

function paintLineSeries(points, color, plotH, options = {}) {
  const elements = [];
  if (!points.length) return elements;
  const strokeWidth = options.strokeWidth ?? 2;
  const canPaintPath = typeof globalThis.window?.paint_path === "function"
    && typeof PathBuilder?.stroke === "function"
    && typeof PathBuilder?.fill === "function";

  if (canPaintPath && points.length >= 2) {
    if (options.fill && typeof Background?.solid === "function") {
      const area = buildAreaPath(points, plotH);
      elements.push(globalThis.window.paint_path(area, Background.solid(color).opacity(0.14))
        .absolute().inset_0());
    }
    const path = buildPolylinePath(points, strokeWidth, options.dash ?? null);
    const paint = options.opacity != null && typeof Background?.solid === "function"
      ? Background.solid(color).opacity(options.opacity)
      : color;
    elements.push(globalThis.window.paint_path(path, paint).absolute().inset_0());
  } else {
    // Box fallback when PathBuilder/window.paint_path is absent (e.g. legacy runtime or bare mock).
    for (const pt of points) {
      if (pt.val > 0 || points.length === 1) {
        elements.push(div().absolute().left(`${pt.xPct}%`).top(clamp(pt.y - 2, 0, plotH - 4))
          .size(4).ml(-2).rounded_full().bg(color));
      }
    }
  }

  if (options.dots) {
    for (const pt of points) {
      if (pt.val <= 0 && points.length > 1) continue;
      elements.push(div().absolute().left(`${pt.xPct}%`).top(clamp(pt.y - 2, 0, plotH - 4))
        .size(4).ml(-2).rounded_full().bg(color));
    }
  }
  return elements;
}

/** Line graph over time card (native GPUI PathBuilder polylines + interactive crosshair hover). */
export function lineGraphCard(t, data, colors, state) {
  const { buckets, models, maxBucketTotal, maxCumulativeTotal } = data.series;
  const cumulative = state.lineMode === "cumulative";
  const plotH = state.chartMode === "line" ? PLOT_SINGLE : PLOT_BOTH;
  const count = buckets.length;

  // In per-model mode, include the Total dashed line when >1 model is visible so overall trajectory is clear.
  const showTotalLine = !cumulative && models.length > 1;
  const rawMax = cumulative
    ? maxCumulativeTotal
    : (showTotalLine ? maxBucketTotal : data.series.maxModelBucket || maxBucketTotal);
  const yMax = niceMax(rawMax);

  const lineModeToggle = segmentedPill(t, "hist-line-mode", LINE_MODES, state.lineMode, state.setLineMode);
  const subtitle = cumulative
    ? `Cumulative tokens · ${data.range.label}`
    : showTotalLine
      ? "Per-model token trajectory (dashed line = total)"
      : `Token trajectory · ${data.range.label}`;

  const children = [
    h_flex().w_full().flex_wrap().justify_between().items_center().gap(8)
      .child(v_flex().gap(2)
        .child(div().font_semibold().text_size(14).child("Usage over time"))
        .child(div().text_size(11).text_color(t.muted).child(subtitle)))
      .child(lineModeToggle),
  ];

  if (yMax === 0) {
    children.push(div().py(24).text_center().text_size(12).text_color(t.muted)
      .child("No token trend to plot in this period."));
  } else {
    const elapsed = [];
    for (let i = 0; i < count; i += 1) {
      if (!buckets[i].future) elapsed.push({ idx: i, bucket: buckets[i] });
    }
    const toY = (val) => clamp((1 - val / yMax) * (plotH - 6) + 3, 2, plotH - 2);
    const toXPct = (idx) => ((idx + 0.5) / Math.max(1, count)) * 100;
    const showDots = count <= 31;

    const marks = [...gridLines(t, plotH)];
    const firstFuture = buckets.findIndex((b) => b.future);
    if (firstFuture >= 0 && firstFuture < count) {
      marks.push(div().absolute().top(0).h(plotH)
        .left(`${(firstFuture / count) * 100}%`)
        .w(`${((count - firstFuture) / count) * 100}%`)
        .bg(FUTURE_TINT));
    }

    if (elapsed.length > 0) {
      if (cumulative) {
        const totalPts = elapsed.map(({ idx, bucket }) => ({
          xPct: toXPct(idx),
          y: toY(bucket.cumulativeTotal),
          val: bucket.cumulativeTotal,
        }));
        marks.push(...paintLineSeries(totalPts, t.accent, plotH, {
          strokeWidth: 2,
          fill: true,
          dots: showDots && models.length <= 1,
        }));
        if (models.length > 1) {
          for (const name of models) {
            const pts = elapsed.map(({ idx, bucket }) => {
              const val = bucket.cumulativeByModel?.[name] ?? 0;
              return { xPct: toXPct(idx), y: toY(val), val };
            });
            marks.push(...paintLineSeries(pts, colors.get(name) ?? OTHER_COLOR, plotH, {
              strokeWidth: 1.5,
              dots: false,
            }));
          }
        }
      } else {
        if (showTotalLine) {
          const totalPts = elapsed.map(({ idx, bucket }) => ({
            xPct: toXPct(idx),
            y: toY(bucket.total),
            val: bucket.total,
          }));
          marks.push(...paintLineSeries(totalPts, t.muted, plotH, {
            strokeWidth: 1.5,
            dash: [4, 3],
            opacity: 0.75,
            dots: false,
          }));
        }
        const singleModel = models.length === 1;
        for (const name of models) {
          const pts = elapsed.map(({ idx, bucket }) => {
            const val = bucket.byModel?.[name] ?? 0;
            return { xPct: toXPct(idx), y: toY(val), val };
          });
          marks.push(...paintLineSeries(pts, colors.get(name) ?? OTHER_COLOR, plotH, {
            strokeWidth: 2,
            fill: singleModel,
            dots: showDots,
          }));
        }
      }
    }

    const hoverLayer = h_flex().absolute().inset_0()
      .children(buckets.map((bucket, idx) => div().flex_1().min_w(0).h(plotH).child(
        HoverCard.new(`hist-line-${data.horizon}-${data.offset}-${state.lineMode}-${idx}`)
          .open_delay(0).close_delay(0)
          .trigger(div().w_full().h(plotH).hover((s) => s.bg(HOVER_TINT)))
          .content(bucketTooltip(t, bucket, models, colors, data.includeCache, cumulative)),
      )));

    children.push(
      h_flex().w_full().items_start()
        .child(yAxisGutter(t, yMax, plotH))
        .child(div().relative().flex_1().min_w(0).h(plotH)
          .children(marks)
          .child(hoverLayer)),
      xAxisLabels(t, buckets),
    );
    if (state.chartMode === "line") {
      const legend = seriesLegend(t, models, colors, state.modelFilter, state.setModelFilter);
      if (legend) children.push(legend);
    }
  }

  return surfaceCard(t, children, 8);
}

function leaderboardCard(t, data, colors, state) {
  const { entries, totalModels } = data.leaderboard;
  const maxEntryTokens = entries[0]?.tokens ?? 0;

  const row = (entry) => {
    const selected = state.modelFilter === entry.model;
    const dotColor = colors.get(entry.model) ?? OTHER_COLOR;
    const shareBarPct = maxEntryTokens > 0 ? clamp((entry.tokens / maxEntryTokens) * 100, 1, 100) : 0;
    const providersText = entry.providers.map(providerName).join(", ");
    const effortNote = entry.efforts?.length
      ? `Effort: ${entry.efforts.map((e) => `${e.effort} ${e.sharePct}%`).join(" · ")}`
      : "";
    const tip = [
      `${entry.model} (${providersText})`,
      `${formatInt(entry.tokens)} tokens (${entry.sharePct}%)`,
      `In ${formatInt(entry.input)} · Out ${formatInt(entry.output)}${entry.reasoning ? ` (${formatInt(entry.reasoning)} reasoning)` : ""}`,
      `Cache read ${formatInt(entry.cacheRead)}${entry.cacheWrite ? ` · write ${formatInt(entry.cacheWrite)}` : ""}`,
      `${formatInt(entry.sessions)} sessions · ${formatInt(entry.events)} calls`,
      effortNote,
    ].filter(Boolean).join("\n");

    return h_flex().id(`hist-leader-${entry.rank}`).w_full().items_center().gap(8).px(6).py(7)
      .rounded(5).border_b(1).border_color(t.border).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .tooltip(tip)
      .on_click((_event, cx) => state.setModelFilter(selected ? "all" : entry.model, cx))
      .child(div().w(20).flex_none().text_size(11).text_color(t.dim).child(`${entry.rank}.`))
      .child(div().size(8).flex_none().rounded_full().bg(dotColor))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_size(12).font_semibold().text_color(t.foreground).child(entry.model))
        .child(div().truncate().text_size(10.5).text_color(t.muted)
          .child(`${providersText} · ${entry.sharePct}%`))
        .child(div().w_full().h(2).rounded(1).bg(t.raised)
          .child(div().h_full().w(`${shareBarPct}%`).rounded(1).bg(dotColor))))
      .child(v_flex().flex_none().items_end().gap(2)
        .child(div().text_size(12).font_semibold().text_color(t.foreground)
          .child(`${formatCompact(entry.tokens)} tokens`))
        .map((el) => {
          const badge = deltaBadge(t, entry.deltaKind, entry.deltaPct, entry.prevTokens);
          return badge ? el.child(badge) : el;
        }));
  };

  const half = Math.ceil(entries.length / 2);
  const twoCols = (state.width || 1100) >= 740 && entries.length > 1;
  const left = twoCols ? entries.slice(0, half) : entries;
  const right = twoCols ? entries.slice(half) : [];

  const children = [
    h_flex().w_full().flex_wrap().justify_between().items_center().gap(8)
      .child(div().font_semibold().text_size(14).child("Top models"))
      .child(div().text_size(11).text_color(t.muted)
        .child(`${data.range.label} · ${formatCompact(data.summary.totalTokens)} tokens · ${formatInt(data.summary.sessions)} sessions`)),
  ];

  if (!entries.length) {
    children.push(div().py(16).text_size(12).text_color(t.muted)
      .child("No models recorded in this window."));
  } else {
    children.push(h_flex().w_full().items_start().gap(20)
      .child(v_flex().flex_1().min_w(0).children(left.map(row)))
      .when(right.length > 0, (el) => el.child(v_flex().flex_1().min_w(0).children(right.map(row)))));
    if (totalModels > entries.length) {
      children.push(div().text_size(10.5).text_color(t.dim)
        .child(`Showing top ${entries.length} of ${totalModels} models by tokens. Click any model to filter.`));
    }
  }

  return surfaceCard(t, children, 8);
}

function emptyActionCard(t, data, state) {
  const hasFilters = state.providerFilter !== "all" || state.modelFilter !== "all";
  const latestMs = data.latestActivityMs;
  const canJump = !hasFilters && Number.isFinite(latestMs)
    && (latestMs < data.range.startMs || latestMs >= data.range.endMs);

  return surfaceCard(t, [
    div().font_semibold().text_size(13).child(`No token usage in ${data.range.label}`),
    div().text_size(11.5).text_color(t.muted).child(
      hasFilters
        ? "Try clearing your provider or model filters, or choosing a wider horizon (W, M, Y)."
        : latestMs != null
          ? "Local Claude Code, Codex, and Antigravity token history exists in an earlier period."
          : "Token counts are collected from local Claude Code, Codex, and Antigravity session logs.",
    ),
    h_flex().gap(8).pt(2)
      .when(canJump, (el) => el.child(div().id("hist-jump-latest").h(28).px(10).rounded(5)
        .flex().items_center().bg(t.raised).text_size(11).text_color(t.foreground).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => state.jumpToLatest(latestMs, cx))
        .child("Jump to latest activity")))
      .when(hasFilters, (el) => el.child(div().id("hist-empty-clear").h(28).px(10).rounded(5)
        .flex().items_center().bg(t.raised).text_size(11).text_color(t.foreground).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => state.clearFilters(cx))
        .child("Clear filters"))),
  ], 6);
}

/** Root Historical panel renderer mounted inside breakdown.js. */
export function historicalView(t, state) {
  const data = state.historical;
  const intro = div().text_size(11).text_color(t.muted)
    .child("Local model usage and token counts from Claude Code, Codex, and Antigravity session logs kept in history.sqlite.");

  if (state.historicalError && !data) {
    return v_flex().gap(10)
      .child(intro)
      .child(surfaceCard(t, [
        div().font_semibold().text_size(13).text_color(t.blocked).child("Couldn't read usage history"),
        div().text_size(11.5).text_color(t.muted).child(state.historicalError),
        h_flex().child(div().id("hist-retry").h(28).px(10).rounded(5).flex().items_center()
          .bg(t.raised).text_size(11).text_color(t.foreground).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => state.retryHistorical(cx)).child("Retry")),
      ], 6));
  }

  if (!data) {
    return v_flex().gap(10)
      .child(intro)
      .child(controlsBar(t, null, state))
      .child(div().py(16).text_color(t.muted).child("Reading usage history…"));
  }

  const colors = new Map(data.series.models.map((name, i) => [name, modelColor(name, i)]));
  const pendingBackfill = data.backfill?.pendingFiles > 0;
  const showBars = state.chartMode === "both" || state.chartMode === "bars";
  const showLine = state.chartMode === "both" || state.chartMode === "line";

  return v_flex().gap(10)
    .child(intro)
    .child(controlsBar(t, data, state))
    .when(Boolean(state.historicalError), (el) => el.child(div().px(10).py(6).rounded(6)
      .bg(t.surface).border(1).border_color(t.blocked).text_size(11).text_color(t.blocked)
      .child(state.historicalError)))
    .when(pendingBackfill, (el) => el.child(div().px(10).py(6).rounded(6)
      .bg(t.surface).border(1).border_color(t.border).text_size(11).text_color(t.muted)
      .child(`Indexing older local logs (${data.backfill.totalFiles - data.backfill.pendingFiles} of ${data.backfill.totalFiles} files)…`)))
    .child(kpiStrip(t, data, colors, state.width))
    .when(data.summary.totalTokens === 0, (el) => el.child(emptyActionCard(t, data, state)))
    .when(data.summary.totalTokens > 0 && showBars, (el) => el.child(stackedBarCard(t, data, colors, state)))
    .when(data.summary.totalTokens > 0 && showLine, (el) => el.child(lineGraphCard(t, data, colors, state)))
    .when(data.summary.totalTokens > 0, (el) => el.child(leaderboardCard(t, data, colors, state)))
    .when(data.summary.unmeasuredEvents > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim)
      .child(`${formatInt(data.summary.unmeasuredEvents)} earlier events logged before token tracking are excluded from token totals.`)));
}
