import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { LIGHT_LABEL, creditLight, light, lightColor, windowLength } from "./pace.js";
import { burndownCards } from "./burndown.js";
import { historicalView } from "./historical.js";
import { duration, localTime, timed } from "./time.js";

const PROVIDERS = { copilot: "GitHub Copilot", cursor: "Cursor", grok: "Grok", opencode: "OpenCode" };
const WINDOWS = { session: "Session", day: "Daily", week: "Weekly", month: "Monthly" };

function remaining(used) {
  return 100 - Math.round(used);
}

function dot(t, level) {
  return div().flex_none().size(8).rounded_full().bg(lightColor(t, level));
}

function paceNote(lit) {
  if (!Number.isFinite(lit.spare)) return "";
  const points = Math.round(Math.abs(lit.spare));
  return lit.level === "untapped" ? `≈${points}% spare at this pace`
    : lit.level === "tight" ? `≈${points}% short at this pace` : "";
}

// One allowance: its light, % left, a bar, and a tick where an even pace would be.
function metric(t, label, percent, caption, lit = { level: null }) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  const color = lit.level ? lightColor(t, lit.level) : t.muted;
  const note = paceNote(lit);
  return v_flex().gap(5).py(5).child(h_flex().justify_between().gap(12)
    .child(h_flex().min_w(0).gap(6).items_center()
      .when(Boolean(lit.level), (el) => el.child(dot(t, lit.level)))
      .child(div().min_w(0).text_color(t.foreground).child(label)))
    .when(value !== null, (el) => el.child(div().flex_none().font_semibold()
      .text_color(lit.level ? color : t.foreground).child(`${value}% left`))))
    .when(value !== null, (el) => el.child(div().relative().h(4).w_full().rounded(2).bg(t.raised)
      .child(div().h_full().w(`${value}%`).rounded(2).bg(color))
      .when(Number.isFinite(lit.timeLeft), (bar) => bar.child(div().absolute().top(-3).h(10).w(2).rounded(1)
        .left(`${Math.max(0, Math.min(99, lit.timeLeft))}%`).bg(t.foreground)))))
    .when(Boolean(caption || note), (el) => el.child(h_flex().gap(6).text_size(11)
      .child(div().min_w(0).text_color(t.muted).child(caption || ""))
      .when(Boolean(note), (row) => row.child(div().flex_none().text_color(color).child(note)))));
}

// A card and its rough height in rows, used to balance the columns.
function card(t, title, subtitle, rows, weight = rows.length) {
  return {
    weight: weight + 1,
    el: v_flex().gap(6).p(12).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .child(div().font_semibold().text_size(14).child(title))
      .when(Boolean(subtitle), (el) => el.child(div().text_size(11).text_color(t.muted).child(subtitle)))
      .children(rows),
  };
}

const COLUMN_MIN = 360;
const GAP = 10;

// As many columns as the dialog's width allows; each card goes to the shortest column.
function columns(cards, width) {
  const count = Math.max(1, Math.min(cards.length, Math.floor((width - 32 + GAP) / (COLUMN_MIN + GAP)) || 1));
  const cols = Array.from({ length: count }, () => ({ weight: 0, els: [] }));
  for (const c of cards) {
    const shortest = cols.reduce((a, b) => (b.weight < a.weight ? b : a));
    shortest.weight += c.weight;
    shortest.els.push(c.el);
  }
  return h_flex().w_full().items_start().gap(GAP)
    .children(cols.map((col) => v_flex().flex_1().min_w(0).gap(GAP).children(col.els)));
}

// Lights a window and notes it for the summary when it's untapped.
function lit(spares, provider, label, remainingPercent, resetsAt, length) {
  const result = light({ remaining: remainingPercent, resetsAt, length });
  if (result.level === "untapped") spares.push({ provider, label, remaining: remainingPercent, ...result });
  return result;
}

function windows(t, spares, name, provider) {
  return (provider.windows ?? []).map((entry) => {
    const left = remaining(entry.used_percent);
    return metric(t, entry.label, left, timed("Resets", entry.resets_at),
      lit(spares, name, entry.label, left, entry.resets_at, windowLength(entry.label)));
  });
}

function providerCards(t, report, spares) {
  const cards = [];
  const claude = report?.claude;
  if (claude) {
    const rows = windows(t, spares, "Claude", claude);
    const extra = claude.extra_usage;
    if (extra) {
      const spend = [extra.used, extra.limit].filter(Boolean).join(" / ");
      const balance = extra.balance_left ? `${extra.balance_left} left` : "";
      rows.push(metric(t, "Extra usage", remaining(extra.used_percent), [spend, balance].filter(Boolean).join(" · ")));
    }
    cards.push(card(t, "Claude", claude.plan, rows));
  }
  const codex = report?.codex;
  if (codex) {
    const rows = windows(t, spares, "Codex", codex);
    const credits = codex.resets;
    if (credits?.available || credits?.items?.length) {
      rows.push(div().mt(4).font_semibold().child(`Reset credits · ${credits.available} available`));
      for (const item of credits.items ?? []) {
        const soon = creditLight({ expiresAt: item.expires_at });
        if (soon.level) spares.push({ provider: "Codex", label: item.title || "Reset credit", credit: true, ...soon });
        rows.push(metric(t, item.title || "Reset credit", null, timed("Expires", item.expires_at), soon));
      }
    }
    cards.push(card(t, "Codex", codex.plan, rows));
  }
  const antigravity = report?.antigravity;
  if (antigravity) {
    const groups = (antigravity.groups ?? []).map((group) => v_flex().gap(3).py(4)
      .child(div().font_semibold().child(group.name))
      .when(Boolean(group.models), (el) => el.child(div().text_size(11).text_color(t.muted).child(group.models)))
      .children((group.buckets ?? []).map((entry) => metric(
        t, entry.label, entry.remaining_percent,
        [timed("Resets", entry.resets_at), entry.description].filter(Boolean).join(" · "),
        lit(spares, "Antigravity", `${group.name} · ${entry.label}`, entry.remaining_percent,
          entry.resets_at, windowLength(entry.label)),
      ))));
    const weight = (antigravity.groups ?? [])
      .reduce((sum, group) => sum + 1.5 + (group.buckets ?? []).length * 1.5, 0);
    cards.push(card(t, "Antigravity", antigravity.tier, groups, weight));
  }
  for (const provider of report?.others ?? []) {
    const name = PROVIDERS[provider.id] ?? provider.id;
    const rows = (provider.windows ?? []).map((entry) => {
      const label = [WINDOWS[entry.kind] ?? entry.kind, entry.scope].filter(Boolean).join(" · ");
      const left = remaining(entry.used_percent);
      return metric(t, label, left, timed("Resets", entry.resets_at),
        lit(spares, name, label, left, entry.resets_at, windowLength(entry.kind)));
    });
    if (provider.credits) {
      const credits = provider.credits;
      rows.push(metric(t, credits.label || "Credits", remaining(credits.used_percent ?? NaN), credits.balance));
    }
    if (provider.resets?.available) {
      rows.push(metric(t, `Reset credits · ${provider.resets.available} available`, null,
        timed("Expires", provider.resets.expires_at)));
    }
    const problem = provider.problem === "expired" ? "Sign-in expired" : provider.problem;
    const subtitle = [provider.plan, problem].filter(Boolean).join(" · ");
    cards.push(card(t, name, subtitle, rows));
  }
  return cards;
}

function legend(t) {
  return h_flex().gap(12).text_size(11).text_color(t.muted)
    .children(["untapped", "pace", "tight"].map((level) => h_flex().gap(5).items_center()
      .child(dot(t, level)).child(LIGHT_LABEL[level])));
}

// What would otherwise reset unused, soonest first.
function untapped(t, spares) {
  const rows = [...spares].sort((a, b) => (a.msLeft ?? Infinity) - (b.msLeft ?? Infinity));
  return v_flex().flex_none().gap(8).p(12).rounded(8).bg(t.surface).border(1)
    .border_color(rows.length ? lightColor(t, "untapped") : t.border)
    .child(h_flex().justify_between().items_center().gap(12)
      .child(div().font_semibold().text_size(14).child("Untapped allowance"))
      .child(legend(t)))
    .when(rows.length === 0, (el) => el.child(div().text_color(t.muted)
      .child("Nothing is going unused: every allowance is on pace or tight.")))
    .children(rows.map((row) => h_flex().gap(8).items_center()
      .child(dot(t, "untapped"))
      .child(div().flex_none().font_semibold().child(row.provider))
      .child(div().min_w(0).flex_1().truncate().text_color(t.muted).child(row.label))
      .child(div().flex_none().text_color(lightColor(t, "untapped")).child(row.credit
        ? `expires in ${duration(row.msLeft)}`
        : [`${row.remaining}% left`, Number.isFinite(row.spare) ? `≈${Math.round(row.spare)}% spare` : "",
          Number.isFinite(row.msLeft) && row.msLeft > 0 ? `resets in ${duration(row.msLeft)}` : ""]
          .filter(Boolean).join(" · ")))));
}

function button(t, id, label, onClick, disabled = false, key = "") {
  const el = div().id(id).h(28).px(10).gap(6).rounded(5).flex().items_center().bg(t.raised);
  const hinted = (e) => (key ? e.child(keyHint(t, key)) : e);
  if (disabled) return hinted(el.text_color(t.muted).child(label));
  return hinted(el.hover((s) => s.bg(t.hover)).cursor_pointer().on_click(onClick).child(label));
}

// A button's shortcut, beside its label.
function keyHint(t, key) {
  return div().text_size(10).text_color(t.dim).child(key);
}

function refreshStatus(t, { manualRefresh, lastRefreshedAt }) {
  const status = v_flex().flex_none().gap(1).text_size(11);
  if (manualRefresh) {
    const running = manualRefresh.elapsedMs === null;
    const elapsed = manualRefresh.elapsedMs ?? Math.max(0, Date.now() - manualRefresh.startedAt);
    const seconds = `${(elapsed / 1000).toFixed(1)}s`;
    const label = manualRefresh.outcome === "failed" ? "Failed"
      : manualRefresh.outcome === "unchanged" ? "No new readings" : "✓ Done";
    const color = manualRefresh.outcome === "failed" ? t.blocked
      : manualRefresh.outcome === "unchanged" ? t.muted : t.accent;
    status.child(h_flex().gap(5).items_center().font_semibold()
      .text_color(color)
      .when(running, (el) => el.child(svg("mods/usage-monitor/refresh-spinner.svg")
        .size(11).flex_none().text_color(t.accent).spin(750)))
      .child(running ? seconds : `${label} · ${seconds}`));
  }
  const time = lastRefreshedAt ? localTime(lastRefreshedAt, true) : "—";
  return status.child(div().text_color(t.muted).child(`Last refreshed ${time}`));
}

// Allowances | Burndown | History, switched with A, B and H (U aliases A), or cycled with Space.
function views(t, current, choose) {
  const items = [
    ["allowances", "Allowances", "A"],
    ["burndown", "Burndown", "B"],
    ["historical", "History", "H"],
  ];
  const pill = h_flex().gap(2).p(2).rounded(6).bg(t.raised).children(items
    .map(([view, label, key]) => {
      const el = div().id(`view-${view}`).h(24).px(10).gap(6).rounded(4).flex().items_center();
      return (view === current ? el.bg(t.selected).text_color(t.foreground)
        : el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
          .on_click((_event, cx) => choose(view, cx)))
        .child(label).child(keyHint(t, key));
    }));
  return h_flex().gap(6).items_center().child(pill).child(keyHint(t, "Space"));
}

function burndownView(t, state) {
  const cards = burndownCards(t, state.history?.burndowns, state.history?.modelUsage)
    .map((c) => card(t, c.title, "", c.rows, c.weight));
  const intro = div().text_size(11).text_color(t.muted)
    .child("The dot marks the latest allowance reading. The faint background tint shows elapsed time. "
      + "The dotted diagonal shows an even pace to reset. The band is green ahead of pace, "
      + "yellow a little behind and red 20 or more points behind.");
  if (cards.length) return v_flex().gap(8).child(intro).child(columns(cards, state.width ?? 0));
  const note = state.historyError || (state.history
    ? "No readings yet. They're recorded each time allowances are read, every few minutes while Herdr is open."
    : "Reading history…");
  return v_flex().gap(8).child(intro).child(div().text_color(state.historyError ? t.blocked : t.muted).child(note));
}

export function breakdown(t, report, state) {
  const view = state.view === "burndown" || state.view === "historical" ? state.view : "allowances";
  const burndown = view === "burndown";
  const historical = view === "historical";
  const spares = [];
  const cards = !burndown && !historical ? providerCards(t, report, spares) : [];
  const backfillPending = state.historical?.backfill?.pendingFiles > 0;
  const message = state.error || (state.pending ? "Refreshing allowances…"
    : historical && backfillPending ? `Indexing older logs (${state.historical.backfill.totalFiles - state.historical.backfill.pendingFiles}/${state.historical.backfill.totalFiles})…`
    : historical && state.historicalPending ? "Loading usage history…"
    : report?.partial ? "Partial report"
    : state.stale ? "Cached allowances" : "");
  return v_flex().id("usage-root").size_full().overflow_hidden().bg(t.popover).text_color(t.foreground).text_size(12)
    .when(Boolean(state.focus), (el) => el.track_focus(state.focus).on_key_down(state.onKey))
    .on_size_change(state.onSize)
    .child(h_flex().flex_none().flex_wrap().justify_between().items_center().gap(8).px(16).py(12)
      .border_b(1).border_color(t.border)
      .child(h_flex().gap(12).items_center()
        .child(div().text_size(16).font_semibold().child("Usage Monitor"))
        .child(views(t, view, state.setView)))
      .child(h_flex().flex_none().items_center().gap(8)
        .child(button(t, "refresh-usage", "Refresh", state.refresh, state.pending, "R"))
        .child(refreshStatus(t, state))
        .child(button(t, "close-usage", "Close", state.close))))
    .child(v_flex().id("usage-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(8)
      .when(historical, (el) => el.child(historicalView(t, state)))
      .when(burndown, (el) => el.child(burndownView(t, state)))
      .when(!burndown && !historical && cards.length > 0, (el) => el.child(untapped(t, spares)).child(columns(cards, state.width ?? 0)))
      .when(!burndown && !historical && cards.length === 0, (el) => el.child(div().text_color(t.muted)
        .child(state.pending ? "Reading provider allowances…" : "No provider allowances available."))))
    .when(Boolean(message), (el) => el.child(div().flex_none().px(16).py(10).border_t(1).border_color(t.border)
      .text_color(state.error ? t.blocked : t.muted).child(message)));
}
