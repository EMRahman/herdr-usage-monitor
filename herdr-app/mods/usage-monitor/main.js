import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, closeOverlay, exec, focused, home, layout, openOverlay, props,
  readTextFile, run, setShared, shared, terminals, theme } from "herdr";
import { breakdown, resetIcon } from "./breakdown.js";
import { PROVIDER_NAMES } from "./burndown.js";
import { normalizeChartPrefs, offsetForTimestamp } from "./historical.js";
import { heldResets, providerDetail, RESET_COLOR, resetNote } from "./pace.js";
import { focusedProvider, PANEL_ID, rightPanel } from "./panel.js";
import { hasFreshAllowance } from "./time.js";

const ID = "usage-monitor";
const REVISION = `${ID}.revision`;
const CHART_PREFS = `${ID}.chartPrefs`;
const PINNED_PROVIDER = `${ID}.pinnedProvider`;
const POLL_MS = 60_000;
const RESULT_MS = 5_000;
const BACKFILL_DELAY_MS = 300;
const VIEWS = ["allowances", "burndown", "historical"];
const CHART_MODES = ["both", "bars", "line"];

// Shared by every copy: the latest data and error. A task's cx only redraws its own copy,
// so a change is announced through shared state, which redraws every copy. Requests are each
// copy's own: Herdr cancels a copy's pending calls when it closes or reloads, and a request
// shared with other copies could then never settle and block them all.
let snapshot = null;
let config = null;
let bun = null;
let error = "";

// A request settles within exec's 45s timeout; a busy flag older than this is left over
// from a cancelled one.
const BUSY_MS = 50_000;

function lastLine(text) {
  return text.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

// The provider code, prebuilt into this folder: the mod needs only Bun.
const bridge = () => `${appHome()}/mods/${ID}/bridge.js`;

// Bun on Herdr's PATH (the login shell's), else where the installer found it, else where Bun's
// own installer and Homebrew put it. A program that can't start fails at once; anything slower
// is the bridge itself failing, so it isn't retried with another Bun.
async function runBridge(args) {
  // config.json is optional: the installer writes it; a copied-in folder has none.
  config ??= JSON.parse(await readTextFile(`${appHome()}/mods/${ID}/config.json`) || "{}");
  const candidates = [...new Set([bun, "bun", config.bun, `${home()}/.bun/bin/bun`,
    "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].filter(Boolean))];
  for (const candidate of candidates) {
    const started = Date.now();
    try {
      const result = await exec(candidate, [bridge(), ...args], { timeout: 45_000 });
      bun = candidate;
      return result;
    } catch (failure) {
      if (Date.now() - started > 2_000) throw failure;
    }
  }
  throw new Error("Couldn’t find Bun. Install it from bun.sh, then reopen Herdr.");
}

async function readUsage(args) {
  const result = await runBridge(args);
  if (result.code !== 0) {
    const detail = lastLine(result.stderr);
    throw new Error(`Couldn’t read provider allowances${detail ? `: ${detail}` : "."}`);
  }
  return JSON.parse(result.stdout);
}

function apply(next) {
  const previous = snapshot?.report;
  // A sidebar poll and an overlay refresh can finish in either order.
  if (next.report && (!previous || next.report.timestamp >= previous.timestamp)) snapshot = next;
  const changed = Boolean(error) || previous?.timestamp !== snapshot?.report?.timestamp;
  error = "";
  if (changed) setShared(REVISION, Date.now());
}

function fail(failure) {
  const message = failure?.message || String(failure);
  if (message !== error) {
    error = message;
    setShared(REVISION, Date.now());
  }
}

export default class UsageMonitor extends View {
  init(_props, cx) {
    this.isPanel = props()?.mode === "right-panel";
    this.history = null;
    this.historyError = "";
    if (this.isPanel) {
      this.lastProvider = null;
      this.panelHistoryRevision = null;
      if (!checking()) cx.timer.every(POLL_MS, (cx) => {
        const root = layout();
        if (panelIsOpen(root)) this.loadPanelHistory(cx, !readoutIsVisible(root));
      });
      return;
    }

    this.since = 0;
    this.refreshResult = null;
    this.resultTimer = null;
    this.refreshTimer = null;
    this.view = "allowances";
    if (props()?.overlay && props()?.view === "burndown") this.view = "burndown";

    // History panel state (persisted across overlay closes and restarts via Herdr shared state).
    let savedRaw = null;
    try { savedRaw = shared(CHART_PREFS); } catch {}
    const saved = normalizeChartPrefs(savedRaw);
    this.horizon = saved.horizon;
    this.offset = 0;
    this.providerFilter = saved.providerFilter;
    this.modelFilter = saved.modelFilter;
    this.includeCache = saved.includeCache;
    this.chartMode = saved.chartMode;
    this.groupBy = saved.groupBy;
    this.lineMode = saved.lineMode;
    this.openFilter = null;
    this.historical = null;
    this.historicalError = "";
    this.historicalPending = false;
    this.historicalGeneration = 0;
    this.backfill = { pendingFiles: 0, totalFiles: 0 };
    this.activeSyncs = 0;
    this.backfillTimer = null;

    // The breakdown takes the keyboard for its shortcuts: R refreshes, A/B/H switch views
    // (U aliases A), Space cycles them, and D/W/M/Y/[/]/T/G/I/C control History.
    if (props()?.overlay) {
      this.handle = cx.focus_handle();
      this.handle.focus();
    }
    if (checking()) return;

    cx.spawn(async (cx) => {
      if (!snapshot) await this.read(cx, ["--cached"]);
      await this.read(cx, []);
    });
    if (this.view === "burndown") cx.spawn((cx) => this.readHistory(cx));
    else if (this.view === "historical") cx.spawn((cx) => this.readHistorical(cx, { sync: true }));
    cx.timer.every(POLL_MS, (cx) => {
      if (this.handle || readoutIsVisible(layout())) cx.spawn((cx) => this.read(cx, []));
    });
  }

  close() {
    this.refreshTimer?.cancel();
    this.resultTimer?.cancel();
    this.cancelBackfill();
  }

  cancelBackfill() {
    try { this.backfillTimer?.cancel(); } catch {}
    this.backfillTimer = null;
  }

  scheduleBackfill(cx) {
    if (this.view !== "historical" || this.backfill.pendingFiles <= 0) return;
    if (this.backfillTimer || this.activeSyncs > 0) return;
    this.backfillTimer = cx.timer.after(BACKFILL_DELAY_MS, (timerCx) => {
      this.backfillTimer = null;
      if (this.view === "historical" && this.backfill.pendingFiles > 0 && this.activeSyncs === 0) {
        timerCx.spawn((nextCx) => this.readHistorical(nextCx, { sync: true }));
      }
    });
  }

  busy() {
    return this.refreshTimer !== null || Date.now() - this.since < BUSY_MS;
  }

  // --cached: whatever is cached, at once. No flag: refreshes when the cache is 3 minutes old.
  // --refresh: asks the providers now.
  async read(cx, args) {
    if (this.busy()) return;
    const startedAt = Date.now();
    const manual = args[0] === "--refresh";
    this.since = startedAt;
    if (this.handle) {
      this.resultTimer?.cancel();
      this.resultTimer = null;
      this.refreshResult = null;
      this.refreshTimer = cx.timer.every(100, (timerCx) => timerCx.notify());
    }
    cx.notify();
    let outcome = "failed";
    try {
      try {
        const next = await readUsage(args);
        apply(next);
        if (manual && next.report) {
          outcome = hasFreshAllowance(next.report) ? "done" : "unchanged";
        }
      } catch (failure) {
        fail(failure);
      }
      if (this.view === "burndown") {
        await this.readHistory(cx);
        if (this.historyError) outcome = "failed";
      } else if (this.view === "historical") {
        await this.readHistorical(cx, { sync: this.backfill.pendingFiles > 0 });
        if (this.historicalError) outcome = "failed";
      }
    } finally {
      this.since = 0;
      this.refreshTimer?.cancel();
      this.refreshTimer = null;
      if (manual) {
        this.refreshResult = { elapsedMs: Math.max(0, Date.now() - startedAt), outcome };
        this.resultTimer = cx.timer.after(RESULT_MS, (timerCx) => {
          this.resultTimer = null;
          this.refreshResult = null;
          timerCx.notify();
        });
      }
      cx.notify();
    }
  }

  setView(view, cx) {
    this.view = view;
    this.openFilter = null;
    if (view !== "historical") this.cancelBackfill();
    if (view === "burndown") cx.spawn((cx) => this.readHistory(cx));
    else if (view === "historical") cx.spawn((cx) => this.readHistorical(cx, { sync: true }));
    cx.notify();
  }

  refresh(cx) {
    if (!this.busy()) cx.spawn((cx) => this.read(cx, ["--refresh"]));
  }

  saveChartPrefs() {
    if (checking()) return;
    try {
      setShared(CHART_PREFS, {
        horizon: this.horizon,
        chartMode: this.chartMode,
        groupBy: this.groupBy,
        lineMode: this.lineMode,
        includeCache: this.includeCache,
        providerFilter: this.providerFilter,
        modelFilter: this.modelFilter,
      });
    } catch {}
  }

  setHorizon(horizon, cx) {
    if (this.horizon === horizon && this.offset === 0) return;
    this.horizon = horizon;
    this.offset = 0;
    this.openFilter = null;
    this.saveChartPrefs();
    cx.spawn((cx) => this.readHistorical(cx, { sync: false }));
    cx.notify();
  }

  stepOffset(delta, cx) {
    const next = Math.min(0, this.offset + delta);
    if (next === this.offset) return;
    this.offset = next;
    cx.spawn((cx) => this.readHistorical(cx, { sync: false }));
    cx.notify();
  }

  resetOffset(cx) {
    if (this.offset === 0) return;
    this.offset = 0;
    cx.spawn((cx) => this.readHistorical(cx, { sync: false }));
    cx.notify();
  }

  jumpToLatest(latestMs, cx) {
    this.offset = offsetForTimestamp(this.horizon, latestMs, Date.now());
    cx.spawn((cx) => this.readHistorical(cx, { sync: false }));
    cx.notify();
  }

  setProviderFilter(provider, cx) {
    if (this.providerFilter === provider) return;
    this.providerFilter = provider;
    this.saveChartPrefs();
    cx.spawn((cx) => this.readHistorical(cx, { sync: false }));
    cx.notify();
  }

  setModelFilter(model, cx) {
    if (this.modelFilter === model) return;
    this.modelFilter = model;
    this.saveChartPrefs();
    cx.spawn((cx) => this.readHistorical(cx, { sync: false }));
    cx.notify();
  }

  clearFilters(cx) {
    if (this.providerFilter === "all" && this.modelFilter === "all") return;
    this.providerFilter = "all";
    this.modelFilter = "all";
    this.openFilter = null;
    this.saveChartPrefs();
    cx.spawn((cx) => this.readHistorical(cx, { sync: false }));
    cx.notify();
  }

  toggleCache(cx) {
    this.includeCache = !this.includeCache;
    this.saveChartPrefs();
    cx.spawn((cx) => this.readHistorical(cx, { sync: false }));
    cx.notify();
  }

  setChartMode(mode, cx) {
    if (this.chartMode === mode) return;
    this.chartMode = mode;
    this.saveChartPrefs();
    cx.notify();
  }

  cycleChartMode(cx) {
    const idx = CHART_MODES.indexOf(this.chartMode);
    this.chartMode = CHART_MODES[(idx + 1) % CHART_MODES.length];
    this.saveChartPrefs();
    cx.notify();
  }

  setLineMode(mode, cx) {
    if (this.lineMode === mode) return;
    this.lineMode = mode;
    this.saveChartPrefs();
    cx.notify();
  }

  setGroupBy(groupBy, cx) {
    if (this.groupBy === groupBy) return;
    this.groupBy = groupBy;
    this.saveChartPrefs();
    cx.notify();
  }

  onKey(event, cx) {
    const key = event.keystroke;
    if (key === "escape" && this.openFilter) {
      this.openFilter = null;
      cx.notify();
      cx.stop_propagation();
      return;
    }
    const idx = VIEWS.indexOf(this.view);
    const nextView = VIEWS[(idx + 1) % VIEWS.length];
    const prevView = VIEWS[(idx + VIEWS.length - 1) % VIEWS.length];
    const action = {
      r: "refresh",
      a: "allowances",
      u: "allowances",
      b: "burndown",
      h: "historical",
      space: nextView,
      "shift-space": prevView,
    }[key];
    if (action) {
      if (action === "refresh") this.refresh(cx);
      else if (action !== this.view) this.setView(action, cx);
      cx.stop_propagation();
      return;
    }
    if (this.view !== "historical") return;
    if (key === "d" || key === "w" || key === "m" || key === "y") {
      this.setHorizon(key, cx);
      cx.stop_propagation();
    } else if (key === "[") {
      this.stepOffset(-1, cx);
      cx.stop_propagation();
    } else if (key === "]") {
      this.stepOffset(1, cx);
      cx.stop_propagation();
    } else if (key === "0" || key === "t") {
      this.resetOffset(cx);
      cx.stop_propagation();
    } else if (key === "g") {
      this.cycleChartMode(cx);
      cx.stop_propagation();
    } else if (key === "i") {
      this.setGroupBy(this.groupBy === "model" ? "type" : "model", cx);
      cx.stop_propagation();
    } else if (key === "c") {
      this.toggleCache(cx);
      cx.stop_propagation();
    }
  }

  // The burndown charts' data, read from the local history while they're on screen.
  async readHistory(cx) {
    try {
      const result = await runBridge(["--history"]);
      if (result.code !== 0) throw new Error(`Couldn’t read the usage history${lastLine(result.stderr) ? `: ${lastLine(result.stderr)}` : "."}`);
      this.history = JSON.parse(result.stdout);
      this.historyError = "";
    } catch (failure) {
      this.historyError = failure?.message || String(failure);
    }
    cx.notify();
  }

  loadPanelHistory(cx, refreshAllowances = false) {
    if (this.panelHistoryPending) return;
    this.panelHistoryPending = true;
    this.panelHistoryRevision = snapshot?.report?.timestamp;
    cx.spawn(async (cx) => {
      try {
        if (refreshAllowances) {
          try {
            apply(await readUsage([]));
          } catch (failure) {
            fail(failure);
          }
          this.panelHistoryRevision = snapshot?.report?.timestamp;
        }
        await this.readHistory(cx);
      } finally {
        this.panelHistoryPending = false;
      }
    });
  }

  // Aggregated local model & token usage for the History panel.
  async readHistorical(cx, { sync = false } = {}) {
    const runSync = sync && this.activeSyncs === 0;
    if (runSync) {
      this.cancelBackfill();
      this.activeSyncs += 1;
    }
    const generation = ++this.historicalGeneration;
    this.historicalPending = true;
    cx.notify();
    const args = [
      "--historical",
      `--horizon=${this.horizon}`,
      `--offset=${this.offset}`,
      `--provider=${this.providerFilter}`,
      `--model=${this.modelFilter}`,
      `--cache=${this.includeCache ? "1" : "0"}`,
      `--sync=${runSync ? "1" : "0"}`,
    ];
    let failed = false;
    try {
      const result = await runBridge(args);
      if (result.code !== 0) {
        failed = true;
        if (generation !== this.historicalGeneration) return;
        throw new Error(`Couldn’t read usage history${lastLine(result.stderr) ? `: ${lastLine(result.stderr)}` : "."}`);
      }
      const payload = JSON.parse(result.stdout);
      if (runSync) {
        this.backfill = payload.backfill ?? { pendingFiles: 0, totalFiles: 0 };
      } else {
        payload.backfill = this.backfill;
      }
      if (generation !== this.historicalGeneration) {
        // Sync finished after the user changed controls: keep backfill state and refresh current view.
        if (runSync && this.view === "historical") {
          if (this.historical) this.historical = { ...this.historical, backfill: this.backfill };
          cx.spawn((nextCx) => this.readHistorical(nextCx, { sync: false }));
        }
        return;
      }
      this.historical = payload;
      this.historicalError = "";
    } catch (failure) {
      failed = true;
      if (generation !== this.historicalGeneration) return;
      this.historicalError = failure?.message || String(failure);
    } finally {
      if (runSync) this.activeSyncs = Math.max(0, this.activeSyncs - 1);
      if (generation === this.historicalGeneration) {
        this.historicalPending = false;
        cx.notify();
      }
      if (!failed && this.view === "historical" && this.backfill.pendingFiles > 0) {
        this.scheduleBackfill(cx);
      }
    }
  }

  renderPanel(t, cx) {
    const root = layout();
    if (!checking() && panelIsOpen(root) && this.panelHistoryRevision !== snapshot?.report?.timestamp) {
      this.loadPanelHistory(cx, this.panelHistoryRevision === null && !readoutIsVisible(root));
    }
    const active = focusedProvider(focused(), terminals());
    if (active) this.lastProvider = active;
    const pinned = shared(PINNED_PROVIDER);
    const provider = pinned || this.lastProvider;
    return rightPanel(t, {
      provider, pinned, focused: Boolean(active), history: this.history, historyError: this.historyError || error,
      report: snapshot?.report,
      togglePin: () => setShared(PINNED_PROVIDER, pinned ? null : provider),
      close: () => run("layout.hide", { id: "panel" }),
      details: () => openOverlay({ kind: "dialog", mod: ID, width: 0.9, height: 0.9, props: { view: "burndown" } }),
    });
  }

  render(cx) {
    const t = theme();
    if (this.isPanel) return this.renderPanel(t, cx);
    const overlay = props()?.overlay;
    if (overlay) {
      const readout = findNode(layout(), ID);
      return breakdown(t, snapshot?.report, {
        pending: this.busy(),
        startedAt: this.since,
        refreshResult: this.refreshResult,
        error,
        refresh: (_event, cx) => this.refresh(cx),
        readoutHidden: Boolean(readout?.hidden),
        toggleReadout: readout ? () => run("layout.toggle", { id: ID }) : null,
        close: () => closeOverlay(overlay),
        view: this.view,
        history: this.history,
        historyError: this.historyError,
        setView: (view, cx) => this.setView(view, cx),
        historical: this.historical,
        historicalError: this.historicalError,
        historicalPending: this.historicalPending,
        horizon: this.horizon,
        offset: this.offset,
        providerFilter: this.providerFilter,
        modelFilter: this.modelFilter,
        includeCache: this.includeCache,
        chartMode: this.chartMode,
        groupBy: this.groupBy,
        lineMode: this.lineMode,
        openFilter: this.openFilter,
        setOpenFilter: (id, cx) => {
          this.openFilter = id;
          cx.notify();
        },
        setHorizon: (horizon, cx) => this.setHorizon(horizon, cx),
        stepOffset: (delta, cx) => this.stepOffset(delta, cx),
        resetOffset: (cx) => this.resetOffset(cx),
        jumpToLatest: (latestMs, cx) => this.jumpToLatest(latestMs, cx),
        setProviderFilter: (provider, cx) => this.setProviderFilter(provider, cx),
        setModelFilter: (model, cx) => this.setModelFilter(model, cx),
        clearFilters: (cx) => this.clearFilters(cx),
        toggleCache: (cx) => this.toggleCache(cx),
        setChartMode: (mode, cx) => this.setChartMode(mode, cx),
        setGroupBy: (groupBy, cx) => this.setGroupBy(groupBy, cx),
        setLineMode: (mode, cx) => this.setLineMode(mode, cx),
        retryHistorical: (cx) => cx.spawn((nextCx) => this.readHistorical(nextCx, { sync: true })),
        focus: this.handle,
        onKey: (event, cx) => this.onKey(event, cx),
        width: this.size?.width,
        onSize: (size, cx) => {
          this.size = size;
          cx.notify();
        },
      });
    }
    // Sits in the sidebar above Settings, styled like the footer's rows. On the folded
    // rail it's just the gauge, tinted by the lowest allowance.
    const root = layout();
    const collapsed = (findNode(root, "sidebar")?.size?.px ?? Infinity) < 160;
    const hasPanel = Boolean(findNode(root, PANEL_ID));
    const hasButton = hasPanel && !collapsed;
    const panelOpen = hasPanel && panelIsOpen(root);
    const parts = snapshot?.parts ?? [];
    const lowest = Math.min(...parts.map((part) => part.remaining ?? Infinity));
    const tint = error ? t.blocked : levelColor(t, lowest) ?? t.muted;
    const held = heldResets(snapshot?.report).filter((entry) => entry.usable);
    const counts = {};
    for (const entry of held) counts[entry.provider] = (counts[entry.provider] ?? 0) + entry.count;
    const summary = [error || snapshot?.summary || "Usage Monitor", heldSummary(held, parts)].filter(Boolean).join("\n\n");
    const tooltip = hasPanel && collapsed ? `${summary}\nRight-click to toggle the Burndown panel` : summary;
    const readout = h_flex().id("usage-details").min_w(0).h(28).px(8).gap(9).items_center().rounded(8)
      .when(hasButton, (el) => el.flex_1().px(4).gap(7))
      .when(collapsed, (el) => el.w(32).px(0).justify_center())
      .text_size(13).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      // Folded or without figures, one tooltip covers the readout; otherwise each provider has its own.
      .when(collapsed || parts.length === 0, (el) => el.tooltip(tooltip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(hasPanel, (el) => el.on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        togglePanel(panelOpen);
      }))
      .on_click(() => run("mod.open", { name: ID }))
      // Folded, a dot on the gauge stands in for the reset marks after each provider's figure.
      .child(div().id("usage-gauge").relative().flex_none().size(14)
        .when(!collapsed && parts.length > 0, (el) => el.tooltip(error || "Usage Monitor: click for every limit and reset"))
        .child(svg(`mods/${ID}/gauge.svg`).size(14).text_color(tint))
        .when(collapsed && held.length > 0, (el) => el.child(div().absolute().top(-2).right(-3).size(7)
          .rounded_full().border(1).border_color(t.chrome).bg(RESET_COLOR))))
      .when(!collapsed, (el) => el.child(parts.length === 0
        ? div().truncate().child(error ? "Usage unavailable" : "Usage")
        : h_flex().min_w(0).gap(8).text_size(12).overflow_hidden().children(parts.map((part) =>
          h_flex().id(`usage-${part.id}`).flex_none().gap(4).items_center()
            .tooltip(providerDetail(snapshot?.report, part.id, PROVIDER_NAMES[part.id] ?? part.name))
            .child(logo(part))
            .child(div().text_color(levelColor(t, part.remaining) ?? t.foreground)
              .child(part.note ?? `${part.remaining}%`))
            .when(Boolean(counts[part.id]), (el) => el.child(resetBadge(t, counts[part.id])))))));

    return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).py(4)
      .when(hasButton, (el) => el.px(4))
      .when(collapsed, (el) => el.px(0).items_center())
      .child(h_flex().min_w(0).w_full().gap(3).items_center()
        .when(collapsed, (el) => el.justify_center())
        .child(readout)
        .when(hasButton, (el) => el.child(h_flex().id("usage-toggle-panel").w(24).h(28).flex_none()
          .justify_center().items_center().rounded(5).cursor_pointer()
          .bg(panelOpen ? t.selected : t.chrome).text_color(panelOpen ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).tooltip(panelOpen ? "Close Burndown panel" : "Open Burndown panel")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => togglePanel(panelOpen))
          .child(svg("mods/workspace-chrome/panel-right.svg").size(14)))));
  }
}

// Each provider's logo, from Herdr's own program icons (its icons/ folder) so the readout matches
// the rest of the app: pictures keep their colors, one-color glyphs take the text color. The
// tooltip names each one.
const LOGOS = {
  claude: ["icons/claude.svg", false], codex: ["icons/codex.svg", false],
  antigravity: ["icons/antigravity.svg", false], cursor: ["icons/cursor.svg", true],
  copilot: ["icons/copilot.svg", true], grok: ["icons/grok.svg", true], opencode: ["icons/opencode.svg", true],
};

function logo(part) {
  const [path, tint] = LOGOS[part.id] ?? [];
  if (!path) return div().child(part.name);
  return tint ? svg(path).size(13).flex_none() : image(path).w(13).h(13).flex_none();
}

// The reset mark after a provider's figure, with a count when it holds more than one. Whether one
// is worth using soon is in that provider's tooltip and the breakdown.
function resetBadge(t, count) {
  return h_flex().flex_none().gap(1).items_center().text_color(RESET_COLOR)
    .child(resetIcon(t, false, 11))
    .when(count > 1, (el) => el.child(div().text_size(11).child(String(count))));
}

// The folded readout's tooltip lines for the resets you hold.
function heldSummary(held, parts) {
  if (!held.length) return "";
  const names = Object.fromEntries(parts.map((part) => [part.id, part.name]));
  const lines = held.map((entry) => [names[entry.provider] ?? entry.provider,
    entry.count > 1 ? `${entry.label} (${entry.count})` : entry.label,
    resetNote(entry), entry.command && `run ${entry.command}`].filter(Boolean).join(" · "));
  return ["Resets you hold:", ...lines].join("\n");
}

// Healthy allowances stay quiet; only low ones take a color.
function levelColor(t, remaining) {
  if (!Number.isFinite(remaining)) return null;
  return remaining <= 10 ? t.blocked : remaining <= 30 ? t.ansi3 : null;
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function panelIsOpen(root) {
  const panel = findNode(root, "panel");
  return Boolean(panel && !panel.hidden && findNode(panel, "panel-body")?.active === PANEL_ID);
}

function readoutIsVisible(root) {
  const readout = findNode(root, ID);
  return Boolean(readout && !readout.hidden && !findNode(root, "sidebar")?.hidden);
}

function togglePanel(open) {
  if (open) {
    run("layout.hide", { id: "panel" });
    return;
  }
  // Herdr's tab bar uses this list to restore the selected panel per space.
  const enabled = shared("workspace.panels") ?? ["files", "changes"];
  if (!enabled.includes(PANEL_ID)) setShared("workspace.panels", [...enabled, PANEL_ID]);
  run("layout.select", { stack: "panel-body", child: PANEL_ID });
  run("layout.show", { id: "panel" });
}
