import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { compactAllowances } from "./breakdown.js";
import { burndownChart, PROVIDER_NAMES } from "./burndown.js";
import { sampleStatus } from "./time.js";

export const PANEL_ID = "usage-monitor-panel";

const PROGRAM_PROVIDERS = new Map([
  ["claude", "claude"], ["claude-code", "claude"], ["codex", "codex"],
  ["antigravity", "antigravity"], ["agy", "antigravity"],
  ["cursor", "cursor"], ["cursor-agent", "cursor"],
  ["copilot", "copilot"], ["github-copilot", "copilot"],
  ["grok", "grok"], ["grok-cli", "grok"], ["opencode", "opencode"],
]);

const HOUR = 3_600_000;

export function focusedProvider(focus, terminals) {
  const address = focus?.shown ?? focus?.terminal ?? focus?.agent;
  if (!address) return null;
  const terminal = terminals.find((entry) => entry.address === address);
  return PROGRAM_PROVIDERS.get(terminal?.report?.app?.toLowerCase())
    ?? PROGRAM_PROVIDERS.get(terminal?.program?.key?.toLowerCase()) ?? null;
}

// Use one account, 5-hour before weekly, and for Antigravity include every model group
// (e.g. Gemini and Claude & GPT).
export function panelWindows(history, provider) {
  const charts = (history.burndowns ?? []).filter((chart) => chart.provider === provider);
  const account = history.activeAccounts?.[provider];
  const accounts = new Set(charts.map((chart) => chart.account));
  const active = account === undefined && accounts.size <= 1 ? charts
    : charts.filter((chart) => chart.account === account);
  const sessions = active.filter((chart) => chart.length === 5 * HOUR);
  const weeks = active.filter((chart) => chart.length === 168 * HOUR);
  const pickWeekly = (list) => list.find((chart) => /\bweekly\b/i.test(chart.label)) ?? list[0];

  if (provider === "antigravity" && active.length) {
    const groups = [...new Set(active.map((chart) => chart.group))];
    const pairFor = (group) => [
      sessions.find((chart) => chart.group === group),
      pickWeekly(weeks.filter((chart) => chart.group === group)),
    ];
    return groups.length === 1 ? pairFor(groups[0]) : groups.flatMap((group) => pairFor(group).filter(Boolean));
  }

  const session = sessions.find((chart) => weeks.some((week) => week.group === chart.group)) ?? sessions[0];
  const groupWeeks = weeks.filter((chart) => chart.group === session?.group);
  const weekly = groupWeeks.length ? groupWeeks : weeks;
  return [session, pickWeekly(weekly)];
}

function button(t, id, label, action, tooltip = label) {
  return h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(5)
    .bg(t.raised).text_color(t.foreground).cursor_pointer().hover((style) => style.bg(t.hover))
    .tooltip(tooltip).on_click(action).child(label);
}

// Asks every provider now, then reloads the burndowns; the spinner replaces it meanwhile. Its
// tooltip carries the panel provider's sample age, and it turns yellow at 5 minutes, like the
// breakdown header.
function refreshButton(t, { provider, report, refreshing, refresh }) {
  const scoped = report && provider && {
    timestamp: report.timestamp, read_at: report.read_at, ttl: report.ttl, [provider]: report[provider],
    others: (report.others ?? []).filter(({ id }) => id === provider),
  };
  const sample = sampleStatus(scoped ?? report);
  return h_flex().id("usage-panel-refresh").size(24).flex_none().justify_center().items_center().rounded(5)
    .bg(t.background).text_color(refreshing ? t.accent : sample.stale ? t.ansi3 : t.dim)
    .when(!refreshing, (el) => el.cursor_pointer().on_click(refresh)
      .hover((style) => style.bg(t.hover).text_color(t.foreground))
      .tooltip(`${sample.label}\nClick to ask every provider now`))
    .when(refreshing, (el) => el.tooltip("Refreshing…"))
    .child(refreshing ? svg("mods/usage-monitor/refresh-spinner.svg").size(12).spin(750)
      : svg("mods/usage-monitor/refresh.svg").size(14));
}

// Pinned, the panel keeps its provider when focus moves to another agent; otherwise it follows
// the focused one. The icon's colour is the state, and its tooltip spells it out.
function pinButton(t, { provider, pinned, focused, togglePin }) {
  const name = PROVIDER_NAMES[provider] ?? provider;
  const now = pinned ? `Pinned to ${name}` : focused ? "Following the focused agent" : `Showing ${name}, the last active agent`;
  const next = pinned ? "Click to follow the focused agent" : `Click to keep ${name} here when focus changes`;
  return h_flex().id("usage-panel-pin").size(24).flex_none().justify_center().items_center().rounded(5)
    .cursor_pointer().bg(pinned ? t.selected : t.background).text_color(pinned ? t.foreground : t.dim)
    .hover((style) => style.bg(t.hover).text_color(t.foreground))
    .tooltip(`${now}\n${next}`).on_click(togglePin)
    .child(svg("mods/workspace-chrome/pin.svg").size(14));
}

function burndownSection(t, state) {
  const { provider, history, historyError } = state;
  const muted = (label) => div().text_color(t.muted).child(label);
  const content = v_flex().gap(8);

  if (!provider) {
    content.child(muted("Focus a supported coding agent to see its burndown."));
    return content;
  }

  content.child(div().truncate().font_semibold().text_size(14).child(PROVIDER_NAMES[provider]));

  if (historyError) content.child(div().text_color(t.blocked).child(historyError));
  if (!history) {
    if (!historyError) content.child(muted("Loading burndown…"));
    return content;
  }

  const now = Date.now();
  const windows = panelWindows(history, provider);
  const activity = (history.modelUsage ?? []).filter((event) => event.provider === provider);
  const fallbackLabels = ["5-hour", "Weekly"];
  for (const [index, chart] of windows.entries()) {
    const label = fallbackLabels[index] ?? "Burndown";
    content.child(v_flex().min_w(0).px(8).py(4).rounded(6).border_1().border_color(t.border).bg(t.surface)
      .child(chart ? burndownChart(t, chart, activity, `usage-panel-${provider}-${index}`, now, true)
        : div().py(8).child(muted(`${label} burndown unavailable`))));
  }
  return content;
}

// The same card as Herdr's Files and Changes panels: rounded, on the background, with a 42px
// header holding the title. Herdr's tab bar or the sidebar opens and closes it.
export function rightPanel(t, state) {
  return v_flex().id("usage-panel").size_full().min_w(0).min_h(0).rounded(10).overflow_hidden().bg(t.background)
    .border_1().border_color(t.border).text_size(12).text_color(t.foreground)
    .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().text_size(13).child("Usage"))
      .child(div().flex_1())
      .child(refreshButton(t, state))
      .when(Boolean(state.provider), (el) => el.child(pinButton(t, state)))
      .child(button(t, "usage-panel-details", "Details", state.details, "Open the full Burndown view")))
    .child(v_flex().id("usage-panel-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8)
      .child(burndownSection(t, state))
      .when(Boolean(state.provider), (el) => el.child(compactAllowances(t, state.report, state.provider))));
}
