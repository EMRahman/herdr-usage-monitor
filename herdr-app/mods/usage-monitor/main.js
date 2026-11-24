import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, closeOverlay, exec, home, layout, props, readTextFile, run, setShared, shared, theme } from "herdr";
import { breakdown } from "./breakdown.js";
import { normalizeChartPrefs, offsetForTimestamp } from "./historical.js";
import { latestAllowanceReadAt } from "./time.js";

const ID = "usage-monitor";
const REVISION = `${ID}.revision`;
const CHART_PREFS = `${ID}.chartPrefs`;
const LAST_MANUAL_REFRESH = `${ID}.lastManualRefresh`;
const POLL_MS = 60_000;
const STALE_MS = 5 * 60_000;
const BACKFILL_DELAY_MS = 300;
const VIEWS = ["allowances", "burndown", "historical"];
const CHART_MODES = ["both", "bars", "line"];

// Shared by every copy: the latest data and error. A task's cx only redraws its own copy,
// so a change is announced through shared state, which redraws every copy. Requests are each
// copy's own: Herdr cancels a copy's pending calls when it closes or reloads, and a request
// shared with other copies could then never settle and block them all.
let snapshot = null;
let latestReadAt = 0;
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

function apply(next, readAt) {
  const changed = Boolean(error) || readAt > latestReadAt
    || (next.report && next.report.timestamp !== snapshot?.report?.timestamp);
  if (next.report) snapshot = next;
  latestReadAt = Math.max(latestReadAt, readAt);
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

function lastRefreshedAt() {
  const manual = shared(LAST_MANUAL_REFRESH);
  return Math.max(latestReadAt, Number.isFinite(manual) ? manual : 0);
}

export default class UsageMonitor extends View {
  init(_props, cx) {
    this.since = 0;
    this.manualRefresh = null;
    this.refreshTimer = null;
    this.view = "allowances";
    this.history = null;
    this.historyError = "";

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
    // (U aliases A), Space cycles them, and D/W/M/Y/[/]/T/G/C control History.
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
    cx.timer.every(POLL_MS, (cx) => cx.spawn((cx) => this.read(cx, [])));
  }

  close() {
    this.refreshTimer?.cancel();
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
    if (manual) {
      this.manualRefresh = { startedAt, elapsedMs: null, previousRefreshAt: lastRefreshedAt() };
      this.refreshTimer = cx.timer.every(100, (timerCx) => timerCx.notify());
    }
    cx.notify();
    let outcome = "failed";
    try {
      try {
        const next = await readUsage(args);
        const readAt = latestAllowanceReadAt(next.report);
        // A legacy cache has only the report timestamp. New reports also record the age of each reading.
        const legacyTime = args[0] === "--cached" && !next.report?.read_at ? next.report?.timestamp : 0;
        apply(next, readAt || legacyTime || 0);
        if (next.report) outcome = readAt > 0 && readAt >= next.report.timestamp ? "done" : "unchanged";
      } catch (failure) {
        fail(failure);
      } finally {
        this.since = 0;
        cx.notify();
      }
      if (this.view === "burndown") {
        await this.readHistory(cx);
        if (this.historyError) outcome = "failed";
      } else if (this.view === "historical") {
        await this.readHistorical(cx, { sync: this.backfill.pendingFiles > 0 });
        if (this.historicalError) outcome = "failed";
      }
    } finally {
      if (manual) {
        const finishedAt = Date.now();
        this.refreshTimer.cancel();
        this.refreshTimer = null;
        this.manualRefresh = { elapsedMs: Math.max(0, finishedAt - startedAt), outcome };
        if (outcome === "done") setShared(LAST_MANUAL_REFRESH, finishedAt);
        cx.notify();
      }
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

  render() {
    const t = theme();
    const overlay = props()?.overlay;
    if (overlay) {
      return breakdown(t, snapshot?.report, {
        pending: this.busy(),
        manualRefresh: this.manualRefresh,
        lastRefreshedAt: this.manualRefresh?.previousRefreshAt ?? lastRefreshedAt(),
        error,
        stale: snapshot?.report?.partial || (latestReadAt > 0 && Date.now() - latestReadAt > STALE_MS),
        refresh: (_event, cx) => this.refresh(cx),
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
    const collapsed = narrow();
    const parts = snapshot?.parts ?? [];
    const lowest = Math.min(...parts.map((part) => part.remaining ?? Infinity));
    const tint = error ? t.blocked : levelColor(t, lowest) ?? t.muted;
    const tooltip = error || snapshot?.summary || "Usage Monitor";
    return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).py(4)
      .when(collapsed, (el) => el.px(0).items_center())
      .child(h_flex().id("usage-details").h(28).px(8).gap(9).items_center().rounded(8)
        .when(collapsed, (el) => el.w(32).px(0).justify_center())
        .text_size(13).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tooltip)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("mod.open", { name: ID }))
        .child(svg(`mods/${ID}/gauge.svg`).size(14).flex_none().text_color(tint))
        .when(!collapsed, (el) => el.child(parts.length === 0
          ? div().truncate().child(error ? "Usage unavailable" : "Usage")
          : h_flex().min_w(0).gap(8).text_size(12).overflow_hidden().children(parts.map((part) =>
            h_flex().flex_none().gap(3)
              .child(part.name)
              .child(div().text_color(levelColor(t, part.remaining) ?? t.foreground)
                .child(part.note ?? `${part.remaining}%`)))))));
  }
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

// Same rule as Herdr's sidebar: under 160px it's the folded rail.
function narrow() {
  return (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
}
