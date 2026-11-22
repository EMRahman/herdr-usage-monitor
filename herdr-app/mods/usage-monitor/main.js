import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, closeOverlay, exec, home, layout, props, readTextFile, run, setShared, theme } from "herdr";
import { breakdown } from "./breakdown.js";

const ID = "usage-monitor";
const REVISION = `${ID}.revision`;
const POLL_MS = 60_000;
const STALE_MS = 5 * 60_000;

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
  const changed = Boolean(error) || (next.report && next.report.timestamp !== snapshot?.report?.timestamp);
  if (next.report) snapshot = next;
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
    this.since = 0;
    this.view = "allowances";
    this.history = null;
    this.historyError = "";
    // The breakdown takes the keyboard for its shortcuts: R refreshes, B and U switch views.
    if (props()?.overlay) {
      this.handle = cx.focus_handle();
      this.handle.focus();
    }
    if (checking()) return;

    cx.spawn(async (cx) => {
      if (!snapshot) await this.read(cx, ["--cached"]);
      await this.read(cx, []);
    });
    cx.timer.every(POLL_MS, (cx) => cx.spawn((cx) => this.read(cx, [])));
  }

  busy() {
    return Date.now() - this.since < BUSY_MS;
  }

  // --cached: whatever is cached, at once. No flag: refreshes when the cache is 3 minutes old.
  // --refresh: asks the providers now.
  async read(cx, args) {
    if (this.busy()) return;
    this.since = Date.now();
    cx.notify();
    try {
      apply(await readUsage(args));
    } catch (failure) {
      fail(failure);
    } finally {
      this.since = 0;
      cx.notify();
    }
    if (this.view === "burndown") await this.readHistory(cx);
  }

  setView(view, cx) {
    this.view = view;
    if (view === "burndown") cx.spawn((cx) => this.readHistory(cx));
    cx.notify();
  }

  refresh(cx) {
    if (!this.busy()) cx.spawn((cx) => this.read(cx, ["--refresh"]));
  }

  onKey(event, cx) {
    const action = { r: "refresh", b: "burndown", u: "allowances" }[event.keystroke];
    if (!action) return;
    if (action === "refresh") this.refresh(cx);
    else if (action !== this.view) this.setView(action, cx);
    cx.stop_propagation();
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

  render() {
    const t = theme();
    const overlay = props()?.overlay;
    if (overlay) {
      return breakdown(t, snapshot?.report, {
        pending: this.busy(),
        error,
        stale: snapshot?.report?.partial || Date.now() - snapshot?.report?.timestamp > STALE_MS,
        refresh: (_event, cx) => this.refresh(cx),
        close: () => closeOverlay(overlay),
        view: this.view,
        history: this.history,
        historyError: this.historyError,
        setView: (view, cx) => this.setView(view, cx),
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
    const tooltip = error || snapshot?.summary || "Subscription usage";
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
