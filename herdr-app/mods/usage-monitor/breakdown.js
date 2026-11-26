import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { LIGHT_LABEL, RESET_COLOR, WINDOW_NAMES, adviseUntapped, creditLight, heldResets, light, lightColor,
  resetNote, windowLength } from "./pace.js";
import { burndownCards } from "./burndown.js";
import { historicalView } from "./historical.js";
import { duration, refreshDuration, sampleStatus, timed } from "./time.js";

const PROVIDERS = { copilot: "GitHub Copilot", cursor: "Cursor", grok: "Grok", opencode: "OpenCode" };
const NAMES = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", ...PROVIDERS };

function remaining(used) {
  return 100 - Math.round(used);
}

function dot(t, level) {
  return div().flex_none().size(8).rounded_full().bg(lightColor(t, level));
}

/** A held reset's mark, in the reset color: dimmed only when the reset can't be used right now. */
export function resetIcon(t, dim = false, size = 10) {
  return svg("mods/usage-monitor/reset.svg").size(size).flex_none().text_color(dim ? t.muted : RESET_COLOR);
}

function paceNote(lit) {
  if (!Number.isFinite(lit.spare)) return "";
  const points = Math.round(Math.abs(lit.spare));
  return lit.level === "untapped" ? `≈${points}% spare at this pace`
    : lit.level === "tight" ? `≈${points}% short at this pace` : "";
}

// One allowance: its light, % left, a bar, and a tick where an even pace would be. Without a
// percentage, `amount` (a balance, say) stands in its place, with no bar. A held reset (level
// "reset") takes the reset mark in place of a light.
function metric(t, label, percent, caption, lit = { level: null }, amount = "", compact = false) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  const reset = lit.level === "reset";
  const color = reset ? (lit.urgent ? RESET_COLOR : t.foreground) : lit.level ? lightColor(t, lit.level) : t.muted;
  const note = compact ? (lit.level === "tight" ? LIGHT_LABEL.tight : "") : paceNote(lit);
  const figure = value !== null ? `${value}% left` : amount;
  return v_flex().gap(compact ? 2 : 5).py(compact ? 3 : 5).child(h_flex().justify_between().gap(12)
    .child(h_flex().min_w(0).gap(6).items_center()
      .when(Boolean(lit.level), (el) => el.child(reset ? resetIcon(t, lit.dim) : dot(t, lit.level)))
      .child(div().min_w(0).text_color(t.foreground)
        .when(compact, (el) => el.truncate().tooltip(label)).child(label)))
    .when(Boolean(figure), (el) => el.child(div().flex_none().font_semibold()
      .text_color(lit.level ? color : t.foreground).child(figure))))
    .when(value !== null && !compact, (el) => el.child(div().relative().h(4).w_full().rounded(2).bg(t.raised)
      .child(div().h_full().w(`${value}%`).rounded(2).bg(color))
      .when(Number.isFinite(lit.timeLeft), (bar) => bar.child(div().absolute().top(-3).h(10).w(2).rounded(1)
        .left(`${Math.max(0, Math.min(99, lit.timeLeft))}%`).bg(t.foreground)))))
    .when(Boolean(caption || note), (el) => el.child(h_flex().gap(6).text_size(11)
      .when(!compact || Boolean(caption), (row) => row.child(div().min_w(0).text_color(t.muted)
        .when(compact, (el) => el.truncate().tooltip(caption)).child(caption || "")))
      .when(Boolean(note), (row) => row.child(div().flex_none().text_color(color).child(note)))));
}

// A card and its rough height in rows, used to balance the columns.
function card(t, title, subtitle, rows, weight = rows.length, compact = false) {
  return {
    weight: weight + 1,
    el: v_flex().gap(compact ? 3 : 6).p(compact ? 8 : 12).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .child(div().font_semibold().text_size(compact ? 12 : 14).child(title))
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

// An Antigravity limit with no reset hasn't started its window yet.
const NOT_STARTED = "No window running: it starts with the next request";

// Lights a window and notes it for the summary when it's untapped.
function lit(spares, provider, label, remainingPercent, resetsAt, length, group = null) {
  const result = light({ remaining: remainingPercent, resetsAt, length });
  if (result.level === "untapped") spares.push({ provider, label, group, length, remaining: remainingPercent, ...result });
  return result;
}

function windows(row, spares, name, provider) {
  return (provider.windows ?? []).map((entry) => {
    const left = remaining(entry.used_percent);
    return row(entry.label, left, timed("Resets", entry.resets_at),
      lit(spares, name, entry.label, left, entry.resets_at, windowLength(entry.label)));
  });
}

function providerCards(t, report, spares, compact = false) {
  const cards = [];
  const row = (label, value, caption, pace, amount) => metric(t, label, value, caption, pace, amount, compact);
  const addCard = (title, subtitle, rows, weight) => cards.push(card(t, title, subtitle, rows, weight, compact));
  const held = heldResets(report);
  const heldBy = (provider) => held.filter((entry) => entry.provider === provider);
  const heldRow = (entry, label, caption) => row(label, null, caption,
    { level: "reset", urgent: entry.urgent, dim: !entry.usable },
    entry.total > 1 ? `${entry.count} of ${entry.total} left` : "");
  const claude = report?.claude;
  if (claude) {
    const rows = windows(row, spares, "Claude", claude);
    const resets = heldBy("claude");
    if (resets.length) {
      const available = resets.reduce((sum, entry) => sum + entry.count, 0);
      rows.push(div().mt(4).font_semibold().child(`Limit resets · ${available} available`));
      for (const entry of resets) {
        const use = entry.status ?? (entry.needsLimit ? "Run /limit-reset at a limit to use it" : "Run /limit-reset to use it");
        rows.push(heldRow(entry, entry.label, [timed("Expires", entry.expiresAt), use].filter(Boolean).join(" · ")));
      }
    }
    const extra = claude.extra_usage;
    if (extra) {
      const spend = [extra.used, extra.limit].filter(Boolean).join(" / ");
      const left = extra.balance_left ? `${extra.balance_left} left` : "";
      rows.push(row("Usage credits", remaining(extra.used_percent),
        [spend && `${spend} this month`, left].filter(Boolean).join(" · ")));
    }
    const credits = claude.credits;
    if (credits) {
      // The part of the balance that expires first, as Claude Code's /usage-credits shows it.
      const first = credits.expiring?.[0];
      const soon = first ? creditLight({ expiresAt: first.expires_at }) : { level: null };
      if (soon.level) spares.push({ provider: "Claude", label: "Usage credits", credit: true, ...soon });
      const expiry = first ? [`${first.amount} ${timed("expires", first.expires_at)}`, first.name]
        .filter(Boolean).join(" · ") : "No expiry";
      rows.push(row("Credit balance", null, expiry, soon, credits.balance));
    }
    addCard("Claude", claude.plan, rows);
  }
  const codex = report?.codex;
  if (codex) {
    const rows = windows(row, spares, "Codex", codex);
    const resets = heldBy("codex");
    if (resets.length) {
      rows.push(div().mt(4).font_semibold().child(`Reset credits · ${codex.resets?.available ?? 0} available`));
      for (const entry of resets) rows.push(heldRow(entry, entry.label, timed("Expires", entry.expiresAt)));
    }
    addCard("Codex", codex.plan, rows);
  }
  const antigravity = report?.antigravity;
  if (antigravity) {
    const groups = (antigravity.groups ?? []).map((group) => v_flex().gap(3).py(4)
      .child(div().font_semibold()
        .when(compact && Boolean(group.models), (el) => el.tooltip(group.models)).child(group.name))
      .when(Boolean(group.models) && !compact, (el) => el.child(div().text_size(11).text_color(t.muted).child(group.models)))
      .children((group.buckets ?? []).map((entry) => row(
        entry.label, entry.remaining_percent,
        [timed("Resets", entry.resets_at) || NOT_STARTED, entry.description].filter(Boolean).join(" · "),
        lit(spares, "Antigravity", `${group.name} · ${entry.label}`, entry.remaining_percent,
          entry.resets_at, windowLength(entry.label), group.name),
      ))));
    const weight = (antigravity.groups ?? [])
      .reduce((sum, group) => sum + 1.5 + (group.buckets ?? []).length * 1.5, 0);
    addCard("Antigravity", antigravity.tier, groups, weight);
  }
  for (const provider of report?.others ?? []) {
    const name = PROVIDERS[provider.id] ?? provider.id;
    const rows = (provider.windows ?? []).map((entry) => {
      const label = [WINDOW_NAMES[entry.kind] ?? entry.kind, entry.scope].filter(Boolean).join(" · ");
      const left = remaining(entry.used_percent);
      return row(label, left, timed("Resets", entry.resets_at),
        lit(spares, name, label, left, entry.resets_at, windowLength(entry.kind)));
    });
    if (provider.credits) {
      const credits = provider.credits;
      rows.push(row(credits.label || "Credits", remaining(credits.used_percent ?? NaN), credits.balance));
    }
    for (const entry of heldBy(provider.id)) {
      rows.push(heldRow(entry, `Reset credits · ${entry.count} available`, timed("Expires", entry.expiresAt)));
    }
    const problem = provider.problem === "expired" ? "Sign-in expired" : provider.problem;
    const subtitle = [provider.plan, problem].filter(Boolean).join(" · ");
    addCard(name, subtitle, rows);
  }
  return cards;
}

export function compactAllowances(t, report, provider) {
  const scopedReport = report && {
    timestamp: report.timestamp,
    read_at: report.read_at,
    [provider]: report[provider],
    others: (report.others ?? []).filter(({ id }) => id === provider),
  };
  const cards = providerCards(t, scopedReport, [], true);
  const sample = sampleStatus(scopedReport);
  return v_flex().gap(8).pt(6)
    .child(h_flex().gap(8).justify_between().items_center()
      .child(div().font_semibold().text_size(13).child("Allowances"))
      .when(cards.length > 0, (el) => el.child(div().min_w(0).truncate().text_size(11)
        .text_color(sample.stale ? t.ansi3 : t.muted).tooltip(sample.detail ?? sample.label).child(sample.label))))
    .when(cards.length === 0, (el) => el.child(div().text_color(t.muted).child("No allowance readings yet.")))
    .children(cards.map(({ el }) => el));
}

function legend(t) {
  return h_flex().gap(12).text_size(11).text_color(t.muted)
    .children(["untapped", "pace", "tight"].map((level) => h_flex().gap(5).items_center()
      .child(dot(t, level)).child(LIGHT_LABEL[level])))
    .child(h_flex().gap(5).items_center().child(resetIcon(t)).child("Reset held"));
}

// A command to type, set apart from the text around it.
function command(t, text) {
  return div().flex_none().px(5).rounded(4).bg(t.raised).text_size(11).text_color(t.foreground).child(text);
}

// Resets you hold, most pressing first. Each one refills whole limits, so all are listed, however
// far off their expiry. A pressing one says why in the reset color.
function heldSection(t, held) {
  return v_flex().gap(8).pt(8).border_t(1).border_color(t.border)
    .child(div().text_size(11).text_color(t.muted).child("Resets you hold"))
    .children(held.map((entry) => h_flex().gap(8).items_center()
      .when(!entry.usable, (el) => el.opacity(0.6))
      .child(resetIcon(t, !entry.usable))
      .child(div().flex_none().font_semibold().child(NAMES[entry.provider] ?? entry.provider))
      .child(div().min_w(0).flex_1().truncate().text_color(t.muted)
        .child(entry.count > 1 ? `${entry.label} · ${entry.count} left` : entry.label))
      .child(div().flex_none().text_color(entry.urgent ? RESET_COLOR : t.muted).child(resetNote(entry)))
      .when(entry.usable && Boolean(entry.command), (el) => el.child(command(t, entry.command)))));
}

// What would otherwise reset unused, soonest first, then the resets you hold.
function untapped(t, spares, held, report) {
  const rows = adviseUntapped(spares, report);
  const hasUse = rows.some((row) => row.kind === "use");
  const hasResetAdvice = rows.some((row) => row.kind === "reset");
  const border = hasUse ? lightColor(t, "untapped")
    : (hasResetAdvice || held.some((entry) => entry.urgent)) ? RESET_COLOR : t.border;
  return v_flex().flex_none().gap(8).p(12).rounded(8).bg(t.surface).border(1)
    .border_color(border)
    .child(h_flex().justify_between().items_center().gap(12)
      .child(div().font_semibold().text_size(14).child("Untapped allowance"))
      .child(legend(t)))
    .when(rows.length === 0, (el) => el.child(div().text_color(t.muted).child(held.length
      ? "Every allowance is on pace or tight."
      : "Nothing is going unused: every allowance is on pace or tight.")))
    .children(rows.map((row) => h_flex().gap(8).items_center()
      .child(row.kind === "reset" ? resetIcon(t) : dot(t, row.kind === "wait" ? "pace" : "untapped"))
      .child(div().flex_none().font_semibold().child(row.provider))
      .child(div().min_w(0).flex_1().truncate().text_color(t.muted).child(row.label))
      .child(div().flex_none()
        .text_color(row.kind === "reset" ? RESET_COLOR : row.kind === "wait" ? lightColor(t, "pace") : lightColor(t, "untapped"))
        .child(row.kind === "wait"
          ? `Wait for weekly reset in ${duration(row.weeklyMsLeft)}`
          : row.kind === "reset"
            ? `Weekly low (${Math.round(row.weeklyRemaining)}% left) · look towards using a reset`
            : row.credit
              ? `expires in ${duration(row.msLeft)}`
              : [`${row.remaining}% left`, Number.isFinite(row.spare) ? `≈${Math.round(row.spare)}% spare` : "",
                Number.isFinite(row.msLeft) && row.msLeft > 0 ? `resets in ${duration(row.msLeft)}` : ""]
                .filter(Boolean).join(" · ")))))
    .when(held.length > 0, (el) => el.child(heldSection(t, held)));
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

function refreshControls(t, report, state) {
  const now = Date.now();
  const sample = sampleStatus(report, now);
  const status = v_flex().id("sample-age").h(28).justify_center().text_size(11)
    .when(Boolean(sample.detail), (el) => el.tooltip(sample.detail))
    .child(div().text_color(sample.stale ? t.ansi3 : t.foreground).child(sample.label));
  if (state.refreshResult) {
    const { outcome, elapsedMs } = state.refreshResult;
    const label = outcome === "failed" ? "Refresh failed" : outcome === "unchanged" ? "No new readings" : "✓ Refreshed";
    status.child(div().text_color(outcome === "failed" ? t.blocked : t.muted)
      .child(`${label} · ${refreshDuration(elapsedMs)}`));
  }
  const label = state.pending ? h_flex().gap(5).items_center()
    .child(svg("mods/usage-monitor/refresh-spinner.svg").size(11).flex_none().text_color(t.accent).spin(750))
    .child(`Refreshing ${refreshDuration(now - state.startedAt)}`) : "Refresh";
  return h_flex().items_center().gap(8)
    .child(status)
    .child(button(t, "refresh-usage", label, state.refresh, state.pending, state.pending ? "" : "R")
      .min_w(114).justify_center());
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
  const message = state.error || (historical && backfillPending ? `Indexing older logs (${state.historical.backfill.totalFiles - state.historical.backfill.pendingFiles}/${state.historical.backfill.totalFiles})…`
    : historical && state.historicalPending ? "Loading usage history…"
    : report?.partial ? "Partial report" : "");
  return v_flex().id("usage-root").size_full().overflow_hidden().bg(t.popover).text_color(t.foreground).text_size(12)
    .when(Boolean(state.focus), (el) => el.track_focus(state.focus).on_key_down(state.onKey))
    .on_size_change(state.onSize)
    .child(h_flex().flex_none().flex_wrap().justify_between().items_center().gap(8).px(16).py(12)
      .border_b(1).border_color(t.border)
      .child(h_flex().gap(12).items_center()
        .child(div().text_size(16).font_semibold().child("Usage Monitor"))
        .child(views(t, view, state.setView)))
      .child(h_flex().flex_none().items_center().gap(8)
        .child(refreshControls(t, report, state))
        .when(Boolean(state.toggleReadout), (el) => el.child(button(t, "toggle-usage-readout",
          state.readoutHidden ? "Show readout" : "Hide readout", state.toggleReadout)
          .tooltip(state.readoutHidden ? "Show Usage at the bottom left" : "Hide Usage from the bottom left")))
        .child(button(t, "close-usage", "Close", state.close))))
    .child(v_flex().id("usage-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(8)
      .when(historical, (el) => el.child(historicalView(t, state)))
      .when(burndown, (el) => el.child(burndownView(t, state)))
      .when(!burndown && !historical && cards.length > 0, (el) => el.child(untapped(t, spares, heldResets(report), report))
        .child(columns(cards, state.width ?? 0)))
      .when(!burndown && !historical && cards.length === 0, (el) => el.child(div().text_color(t.muted)
        .child(state.pending ? "Reading provider allowances…" : "No provider allowances available."))))
    .when(Boolean(message), (el) => el.child(div().flex_none().px(16).py(10).border_t(1).border_color(t.border)
      .text_color(state.error ? t.blocked : t.muted).child(message)));
}
