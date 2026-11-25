import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BRIDGE, bundle } from "./build.ts";
import {
  type LayoutNode, addAboveSidebarFooter, addBesideTabs, findNode, foreignTo, reinsert, removeBesideTabs, removeNode,
  shipped, strip,
} from "./layout.ts";

const MOD = "usage-monitor";
const PANEL = `${MOD}-panel`;
const TAB = `${MOD}-tab`;
const TABS_ROW = `${MOD}-tabs-row`;
const LAYOUT = "herdr-with-usage";
const home = resolve(process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"));
const source = join(import.meta.dir, "mods", MOD);
const destination = join(home, "mods", MOD);
const configPath = join(destination, "config.json");
const layoutsDir = join(home, "layouts");
const keysPath = join(home, "keys.json");
// Cmd keys never reach terminal programs; elsewhere there's no Cmd, so Ctrl+Shift.
const mac = process.platform === "darwin";
const shortcut = mac ? "cmd-u" : "ctrl-shift-u";
const shortcutLabel = mac ? "Cmd+U" : "Ctrl+Shift+U";
const action = `mod.open:${MOD}`;
// The right-hand panel's toggle, delivered to the readout. macOS only: elsewhere Ctrl+Shift+U
// is the breakdown, and Ctrl+Alt is AltGr on Windows.
const panelShortcut = mac ? "cmd-shift-u" : null;
const panelShortcutLabel = "Cmd+Shift+U";
const panelAction = `${MOD}.panel`;
// Editing keys.json makes it the person's: Herdr stops adding new default shortcuts to it.
const bindKey = process.argv.includes("--bind-key");
// --layout <name>: put the readout into another personal layout (one another mod made, say)
// instead of this installer's own. Without it: the layout chosen last time, else the personal
// layout on screen, else this installer's own. --layout herdr-with-usage goes back to ours.
const layoutFlag = process.argv.indexOf("--layout");
const layoutArg = layoutFlag === -1 ? undefined : process.argv[layoutFlag + 1];

// 28px row plus 4px above and below, like the footer's rows.
const BLOCK: LayoutNode = { id: MOD, type: "block", size: { px: 36 }, content: { mod: MOD } };

// The Usage panel's toggle at the end of the tab bar, beside Herdr's Files and Changes. macOS
// only: elsewhere the window buttons end the tab bar, and the toggle stays in the sidebar.
const TAB_BLOCK: LayoutNode = { id: TAB, type: "block", size: { px: 80 }, content: { mod: MOD, props: { mode: "tab-button" } } };

// Everything the mod needs. bridge.js is the provider code, prebuilt by build.ts.
const FILES = ["mod.json", "main.js", "breakdown.js", "burndown.js", "panel.js", "historical.js", "pace.js", "time.js", "gauge.svg", "refresh.svg", "refresh-spinner.svg", "reset.svg", "bridge.js"];

// Optional: the mod also works without it, finding Bun on the PATH.
interface Config {
  /** Bun's path, for when Herdr's PATH doesn't have it. */
  bun: string;
  /** The layout the readout is in. */
  layout?: string;
  /** Hash of our own layout as last written, other mods' blocks left out: anything else
   *  that differs is the person's edit. */
  layoutHash?: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

// Herdr reloads a mod whenever a file in its folder is saved, and a reload drops the work
// its copies had started. Writing only what changed keeps a rerun from reloading it at all.
function writeIfChanged(path: string, data: string | Uint8Array): boolean {
  const next = Buffer.from(data);
  if (existsSync(path) && readFileSync(path).equals(next)) return false;
  writeFileSync(path, next);
  return true;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const layoutFile = (name: string) => join(layoutsDir, `${name}.json`);

function addRightPanel(tree: LayoutNode): boolean {
  const panel = findNode(tree, "panel");
  const stack = panel && findNode(panel, "panel-body");
  if (stack?.type !== "stack" || !stack.children || findNode(tree, PANEL)) return false;
  stack.children.push({ id: PANEL, type: "block", content: { mod: MOD, props: { mode: "right-panel" } } });
  return true;
}

function addTabButton(tree: LayoutNode): boolean {
  return mac && addBesideTabs(tree, structuredClone(TAB_BLOCK), TABS_ROW);
}

/** The panel and its toggle, wherever the readout is. True if anything was added. */
function addPanel(tree: LayoutNode): boolean {
  const panel = addRightPanel(tree);
  return addTabButton(tree) || panel;
}

interface LayoutPlan {
  /** Files to write, by path. */
  writes: Map<string, string>;
  layoutHash: string | undefined;
  notes: string[];
}

// Our own layout: Herdr's main with the readout at the bottom left of the sidebar, above the
// Settings / Add machine footer. Rebuilt from main on every run unless the person edited it;
// other mods' blocks in it don't count as edits and are carried across.
function planOwnLayout(previous: Partial<Config> | null, foreign: (node: LayoutNode) => boolean): LayoutPlan {
  const path = layoutFile(LAYOUT);
  const notes: string[] = [];
  const existing = existsSync(path) ? readJson<LayoutNode>(path) : null;
  const stripped = existing ? strip(existing, foreign) : null;
  if (existing && stripped && hash(json(stripped.tree)) !== previous?.layoutHash) {
    const writes = new Map<string, string>();
    if (findNode(existing, MOD) && addPanel(existing)) writes.set(path, json(existing));
    notes.push(`Kept your layout edits in ${path}.`);
    return { writes, layoutHash: previous?.layoutHash, notes };
  }

  const tree = readJson<LayoutNode>(layoutFile("main"));
  if (!addAboveSidebarFooter(tree, structuredClone(BLOCK))) {
    throw new Error("The main layout has no standard Herdr sidebar footer.");
  }
  addPanel(tree);
  const layoutHash = hash(json(tree));
  for (const lost of reinsert(tree, stripped?.removed ?? [])) {
    notes.push(`Herdr's main layout changed: no place left for the ${lost.node.content?.mod} block. Reinstall that mod.`);
  }
  return { writes: new Map([[path, json(tree)]]), layoutHash, notes };
}

// Someone else's personal layout: only add our block, never rebuild it.
function planOtherLayout(name: string, previous: Partial<Config> | null): LayoutPlan {
  const path = layoutFile(name);
  if (!existsSync(path)) throw new Error(`There's no layout named ${name} in ${layoutsDir}.`);
  const tree = readJson<LayoutNode>(path);
  const writes = new Map<string, string>();
  let changed = false;
  if (!findNode(tree, MOD)) {
    if (!addAboveSidebarFooter(tree, structuredClone(BLOCK))) {
      throw new Error(`The ${name} layout has no standard Herdr sidebar footer.`);
    }
    changed = true;
  }
  if (addPanel(tree) || changed) writes.set(path, json(tree));
  return { writes, layoutHash: previous?.layoutHash, notes: [] };
}

// The personal layout on screen, if Herdr is running: the readout goes where the person looks.
function shownLayout(): string | null {
  const herdrApp = Bun.which("herdr-app");
  if (!herdrApp) return null;
  const status = Bun.spawnSync([herdrApp, "status"], { stdout: "pipe", stderr: "ignore" });
  try {
    const layout = JSON.parse(status.stdout.toString()).layout;
    return typeof layout === "string" ? layout : null;
  } catch {
    return null;
  }
}

function hasSidebarFooter(name: string): boolean {
  const path = layoutFile(name);
  return existsSync(path) && findNode(readJson<LayoutNode>(path), "sidebar-footer") !== null;
}

async function install() {
  const mainLayout = join(home, "layouts", "main.json");
  if (!existsSync(mainLayout)) throw new Error("Open Herdr app once to initialize its configuration, then rerun this installer.");

  // Ours if this installer set it up (config.json) or it was copied in by hand (same files).
  const ours = existsSync(configPath) || existsSync(join(destination, "bridge.js"));
  if (existsSync(destination) && !ours) {
    throw new Error(`A different mod already exists at ${destination}. Use a different Herdr app home to install this copy.`);
  }
  const previous = existsSync(configPath) ? readJson<Partial<Config>>(configPath) : null;

  if (layoutFlag !== -1 && !layoutArg) throw new Error("--layout needs a layout name.");
  const herdr = shipped(home);
  const shown = layoutArg || previous?.layout ? null : shownLayout();
  const joinShown = shown !== null && shown !== LAYOUT && !herdr?.layouts.has(shown) && hasSidebarFooter(shown);
  const target = layoutArg ?? previous?.layout ?? (joinShown ? shown : LAYOUT);
  if (!/^[A-Za-z0-9._-]+$/.test(target)) throw new Error(`Not a layout name: ${target}`);
  if (herdr?.layouts.has(target) || (!herdr && target === "main")) {
    throw new Error(`${target} is one of Herdr's own layouts, which it replaces on every start. Pick a personal layout.`);
  }
  const plan = target === LAYOUT
    ? planOwnLayout(previous, foreignTo(MOD, herdr?.mods ?? null))
    : planOtherLayout(target, previous);

  // Moving to another layout: take the readout out of the one it was in, unless that's ours.
  const moved = previous?.layout && previous.layout !== target && previous.layout !== LAYOUT ? previous.layout : null;
  if (moved && existsSync(layoutFile(moved))) {
    const tree = readJson<LayoutNode>(layoutFile(moved));
    const removedReadout = removeNode(tree, MOD);
    const removedPanel = removeNode(tree, PANEL);
    const removedTab = removeBesideTabs(tree, TABS_ROW);
    const stack = findNode(tree, "panel-body");
    if (removedPanel && stack?.active === PANEL) stack.active = stack.children?.[0]?.id;
    if (removedReadout || removedPanel || removedTab) plan.writes.set(layoutFile(moved), json(tree));
  }

  const keys = existsSync(keysPath) ? readJson<Record<string, Record<string, unknown>>>(keysPath) : null;
  const bindings = Object.values(keys ?? {})
    .flatMap((section) => Object.entries(section))
    .filter(([key]) => key.toLowerCase() === shortcut);
  const keyFree = keys !== null && bindings.length === 0;
  const hasShortcut = keys?.global?.[shortcut] === action && bindings.length === 1;
  if (bindKey && !keyFree && !hasShortcut) {
    throw new Error(`${shortcutLabel} is already bound in ${keysPath}, or the file doesn't exist yet. Rerun without --bind-key.`);
  }
  const canBind = bindKey && keyFree;
  // The panel key is a bonus: taken by something else, it's skipped rather than failing the install.
  const panelBindings = panelShortcut === null ? [] : Object.values(keys ?? {})
    .flatMap((section) => Object.entries(section))
    .filter(([key]) => key.toLowerCase() === panelShortcut);
  const hasPanelShortcut = panelShortcut !== null && keys?.global?.[panelShortcut] === panelAction
    && panelBindings.length === 1;
  const canBindPanel = bindKey && keys !== null && panelShortcut !== null && panelBindings.length === 0;

  // Keep the checkout's prebuilt bridge current, then copy the mod folder as it would be shared.
  writeIfChanged(BRIDGE, await bundle());
  mkdirSync(destination, { recursive: true });
  for (const name of FILES) {
    writeIfChanged(join(destination, name), readFileSync(join(source, name)));
  }

  // Bun.which keeps the PATH entry (e.g. Homebrew's bin link), which survives Bun upgrades;
  // process.execPath resolves to a versioned install folder.
  const config: Config = {
    bun: Bun.which("bun") ?? process.execPath, layout: target, layoutHash: plan.layoutHash,
  };
  writeIfChanged(configPath, json(config));
  if (bindKey && keys && (canBind || hasShortcut)) {
    const global = (keys.global ??= {});
    // Drop this mod's binding from an earlier install under another key (Ctrl+Shift+U before Cmd+U).
    const stale = Object.keys(global).filter((key) => key !== shortcut && global[key] === action);
    for (const key of stale) delete global[key];
    if (canBindPanel) global[panelShortcut] = panelAction;
    if (canBind || canBindPanel || stale.length > 0) {
      global[shortcut] = action;
      writeIfChanged(keysPath, json(keys));
    }
  }

  // Layouts last: a new block starts its mod, which should find every file already in place.
  for (const [path, text] of plan.writes) writeIfChanged(path, text);

  const herdrApp = Bun.which("herdr-app");
  if (herdrApp) {
    const check = Bun.spawnSync([herdrApp, "check", destination], { stdout: "pipe", stderr: "pipe" });
    if (check.exitCode !== 0) {
      throw new Error(`herdr-app check failed:\n${check.stderr.toString() || check.stdout.toString()}`);
    }
  }

  for (const note of plan.notes) console.log(note);
  if (moved) console.log(`Took the readout out of ${moved}.`);
  console.log(`The readout is in the ${target} layout. Select it in the layout picker, or run:\n  herdr-app do layout.switch '{"name":"${target}"}'`);
  if (canBind || hasShortcut) {
    console.log(`Open the breakdown by clicking the readout or pressing ${shortcutLabel}.`);
  } else {
    console.log("Open the breakdown by clicking the readout.");
    console.log(`For a shortcut, rerun with --bind-key to add ${shortcutLabel} to keys.json, or add "${shortcut}": "${action}" under "global" yourself.`);
  }
  if (canBindPanel || hasPanelShortcut) {
    console.log(`Toggle the right-hand Usage panel with ${panelShortcutLabel}.`);
  } else if (bindKey && panelShortcut !== null) {
    console.log(`${panelShortcutLabel} is already bound in ${keysPath}, so the Usage panel has no shortcut. Bind "${panelAction}" to another key under "global" for one.`);
  }
  if (canBind) {
    console.log("Note: keys.json is now edited, so Herdr no longer adds new default shortcuts to it on upgrade.");
  }
}

try {
  await install();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
