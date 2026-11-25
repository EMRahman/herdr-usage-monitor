import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { compactAllowances } from "./breakdown.js";
import { burndownChart, PROVIDER_NAMES } from "./burndown.js";

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

// Use one account and prefer a matching model group across the two windows.
export function panelWindows(history, provider) {
  const charts = (history.burndowns ?? []).filter((chart) => chart.provider === provider);
  const account = history.activeAccounts?.[provider];
  const accounts = new Set(charts.map((chart) => chart.account));
  const active = account === undefined && accounts.size <= 1 ? charts
    : charts.filter((chart) => chart.account === account);
  const sessions = active.filter((chart) => chart.length === 5 * HOUR);
  const weeks = active.filter((chart) => chart.length === 168 * HOUR);
  const session = sessions.find((chart) => weeks.some((week) => week.group === chart.group)) ?? sessions[0];
  const groupWeeks = weeks.filter((chart) => chart.group === session?.group);
  const weekly = groupWeeks.length ? groupWeeks : weeks;
  return [session, weekly.find((chart) => /\bweekly\b/i.test(chart.label)) ?? weekly[0]];
}

function button(t, id, label, action, tooltip = label) {
  return h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(5)
    .bg(t.raised).text_color(t.foreground).cursor_pointer().hover((style) => style.bg(t.hover))
    .tooltip(tooltip).on_click(action).child(label);
}

function burndownSection(t, state) {
  const { provider, pinned, focused, history, historyError } = state;
  const muted = (label) => div().text_color(t.muted).child(label);
  const content = v_flex().gap(8);

  if (!provider) {
    content.child(muted("Focus a supported coding agent to see its burndown."));
    return content;
  }

  content.child(h_flex().gap(8).items_center().justify_between()
    .child(v_flex().min_w(0).gap(2)
      .child(div().truncate().font_semibold().text_size(14).child(PROVIDER_NAMES[provider]))
      .child(muted(pinned ? "Pinned" : focused ? "Following pane" : "Last active agent")))
    .child(button(t, "usage-panel-pin", pinned ? "Follow" : "Pin", state.togglePin,
      pinned ? "Follow the focused coding agent" : "Keep this provider visible when focus changes")));

  if (historyError) content.child(div().text_color(t.blocked).child(historyError));
  if (!history) {
    if (!historyError) content.child(muted("Loading burndown…"));
    return content;
  }

  const now = Date.now();
  const windows = panelWindows(history, provider);
  const activity = (history.modelUsage ?? []).filter((event) => event.provider === provider);
  for (const [index, label] of ["5-hour", "Weekly"].entries()) {
    const chart = windows[index];
    content.child(v_flex().min_w(0).px(8).py(4).rounded(6).border_1().border_color(t.border).bg(t.surface)
      .child(chart ? burndownChart(t, chart, activity, `usage-panel-${provider}-${index}`, now, true)
        : div().py(8).child(muted(`${label} burndown unavailable`))));
  }
  return content;
}

export function rightPanel(t, state) {
  return v_flex().size_full().min_w(0).bg(t.chrome).text_size(12).text_color(t.foreground)
    .child(h_flex().h(40).px(10).gap(6).flex_none().items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child("Usage"))
      .child(button(t, "usage-panel-details", "Details", state.details, "Open the full Burndown view"))
      .child(button(t, "usage-panel-close", "×", state.close, "Close Usage panel")))
    .child(v_flex().id("usage-panel-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8)
      .child(burndownSection(t, state))
      .when(Boolean(state.provider), (el) => el.child(compactAllowances(t, state.report, state.provider))));
}
