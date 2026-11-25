// Re-renders the README screenshots and the gallery preview's cards from made-up readings, in a
// throwaway Herdr window. Run it after a change to how the breakdown looks (macOS, with the Herdr
// app installed):
//
//   bun run screenshots
//
// It writes docs/herdr-app-allowances.png, docs/herdr-app-burndown.png,
// docs/herdr-app-historical.png and docs/herdr-app-sidebar.png (the readout, at 2x), and repaints
// two cards inside herdr-app/preview.png: Allowances, which features the Untapped panel with the
// resets you hold, and Burndown. The rest of the preview (its paper, headline, the "spare at this
// pace" callout, and the compact History card) is a fixed design and stays as it is.
//
// Nothing real is read or changed. The window gets its own Herdr home, terminal core, data and
// cache folders, with telemetry off. The installer puts the readout into that home's layout, then
// the mod's bridge is swapped for sample-bridge.js, which makes up every reading. The mod's clock is frozen at the sample's time, so every image shows
// the same moment. The window, its core and its folders are removed at the end, even after a
// failure.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SHOT_TIME } from "./sample-bridge.js";

const repo = resolve(import.meta.dir, "..", "..");
const modSource = join(repo, "herdr-app", "mods", "usage-monitor");
const preview = join(repo, "herdr-app", "preview.png");

// The window's size; the breakdown dialog is its middle 90%.
const WIDTH = 1740;
const HEIGHT = 1040;
const DIALOG = [WIDTH * 0.05, HEIGHT * 0.05, WIDTH * 0.9, HEIGHT * 0.9];
// The sidebar's foot at 200%: the readout's row, then Settings and Add machine.
const SIDEBAR = [0, 826, 534, 204];

// Where a view's card goes in the preview: a rect of the window shot, scaled and placed as the
// preview was laid out. Each rect's edges sit on the card's plain background.
const PREVIEW: Record<string, Array<{ from: number[]; scale: number; at: number[] }>> = {
  burndown: [{ from: [109, 196, 486, 156], scale: 0.825, at: [607.025, 256.15] }], // Claude 5h session
};

// The preview's Allowances card shows the Untapped panel, drawn in a dialog narrowed to about the
// card's width (this share of the window). `from` is inside the panel's border in that shot; the
// card's slot is cleared to its own background (`sample`) first, then the panel goes in its middle.
const RESETS_DIALOG = 0.34;
const RESETS = { from: [596, 163, 548, 263], scale: 0.8, at: [85.3, 271.8], clear: [81, 261, 446, 232], sample: [80, 380] };

const need = (name: string) => {
  const found = Bun.which(name);
  if (!found) throw new Error(`Couldn't find ${name}. This needs macOS with the Herdr app installed.`);
  return found;
};
const herdr = need("herdr-app");
const hc = need("hc");
const swiftc = need("swiftc");

// A short path: the window's and core's sockets live under it, and socket paths are limited to
// about 100 characters.
const root = mkdtempSync("/tmp/herdr-shots-");
const appHome = join(root, "app");
const mod = join(appHome, "mods", "usage-monitor");
// Every command below runs with this environment, so it reaches only the throwaway window and core.
const env = {
  ...process.env,
  HERDR_APP_HOME: appHome,
  HERDR_APP_NO_SOUND: "1",
  HERDR_TELEMETRY: "0",
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  HC_RUNTIME: join(root, "runtime"),
  HC_SOCKET: join(root, "runtime", "hc.sock"),
  TZ: "UTC",
};

function run(command: string, ...args: string[]): string {
  const result = Bun.spawnSync([command, ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    throw new Error(`${[command, ...args].join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

// The mod's main.js, opening on one view, with its clock frozen at the sample's time: Date.now()
// and new Date() both, so labels that name the day agree with the sample's.
function mainFor(view: string): string {
  const source = readFileSync(join(modSource, "main.js"), "utf8");
  const opening = 'this.view = "allowances";';
  if (source.split(opening).length !== 2) throw new Error(`main.js no longer sets ${opening}`);
  const initialView = [`this.view = ${JSON.stringify(view)};`];
  if (view === "historical") {
    initialView.push('setShared(CHART_PREFS, { groupBy: "type", lineMode: "cumulative" });');
  }
  const lines = source.replace(opening, initialView.join("\n")).split("\n");
  const lastImport = lines.findLastIndex((line) => line.startsWith("import "));
  lines.splice(lastImport + 1, 0, "",
    `const SHOT_NOW = Date.parse(${JSON.stringify(SHOT_TIME)});`,
    "globalThis.Date = class extends Date {",
    "  constructor(...args) { super(...(args.length ? args : [SHOT_NOW])); }",
    "  static now() { return SHOT_NOW; }",
    "};");
  return lines.join("\n");
}

function setUp() {
  for (const dir of ["config", "state", "cache", "data", "runtime"]) mkdirSync(join(root, dir));
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(appHome, "window.json"),
    JSON.stringify({ state: "windowed", bounds: [80, 38, WIDTH, HEIGHT] }));
  const skip = new Set(["bridge.js", "main.js", "config.json", "gpui-kit.d.ts", "jsconfig.json"]);
  for (const file of readdirSync(modSource)) {
    if (!skip.has(file)) copyFileSync(join(modSource, file), join(mod, file));
  }
  copyFileSync(join(import.meta.dir, "sample-bridge.js"), join(mod, "bridge.js"));
  writeFileSync(join(mod, "config.json"), JSON.stringify({ bun: process.execPath }));
  writeFileSync(join(mod, "main.js"), mainFor("allowances"));
  run(swiftc, "-O", join(import.meta.dir, "img.swift"), "-o", join(root, "img"));
}

async function waitForWindow() {
  for (let i = 0; i < 60; i += 1) {
    if (Bun.spawnSync([herdr, "status"], { env, stdout: "ignore", stderr: "ignore" }).success) return;
    await Bun.sleep(500);
  }
  throw new Error("The Herdr window didn't start within 30 seconds.");
}

// The Untapped panel, with the resets you hold, into the preview's Allowances card.
async function capturePreviewResets() {
  const manifestFile = join(mod, "mod.json");
  const manifest = readFileSync(manifestFile, "utf8");
  writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(manifest), overlay: { width: RESETS_DIALOG, height: 0.9 } }));
  writeFileSync(join(mod, "main.js"), mainFor("allowances"));
  await Bun.sleep(1000);
  run(herdr, "do", "mod.open", "--name", "usage-monitor");
  await Bun.sleep(3000);
  const problems = errors();
  if (problems.length) throw new Error(`Herdr reported: ${JSON.stringify(problems)}`);
  const shot = join(root, "resets.png");
  run(herdr, "shot", shot);
  run(herdr, "do", "mod.open", "--name", "usage-monitor");
  writeFileSync(manifestFile, manifest);
  const img = join(root, "img");
  run(img, "fill", preview, ...RESETS.clear.map(String), ...RESETS.sample.map(String));
  run(img, "paste", shot, ...RESETS.from.map(String), String(RESETS.scale), ...RESETS.at.map(String), preview);
}

// The readout sits in the sidebar of the layout the installer makes. The installer copies the
// real mod, so the sample bridge and the frozen main.js go back in after it.
async function installReadout() {
  // The installer builds on the main layout, which Herdr writes as it starts.
  for (let i = 0; i < 40 && !existsSync(join(appHome, "layouts", "main.json")); i += 1) await Bun.sleep(250);
  run("bun", join(repo, "herdr-app", "install.ts"));
  copyFileSync(join(import.meta.dir, "sample-bridge.js"), join(mod, "bridge.js"));
  writeFileSync(join(mod, "config.json"), JSON.stringify({ bun: process.execPath }));
  writeFileSync(join(mod, "main.js"), mainFor("allowances"));
  run(herdr, "do", "layout.switch", "--name", "herdr-with-usage");
  await Bun.sleep(3000);
}

// The readout and the sidebar rows below it, at 2x: Herdr zoomed to 200%, with the welcome
// dialog closed so it doesn't cover the sidebar.
async function captureSidebar() {
  run(herdr, "do", "overlay.close");
  writeFileSync(join(appHome, "settings.json"), JSON.stringify({ zoom: 2 }));
  await Bun.sleep(2000);
  const problems = errors();
  if (problems.length) throw new Error(`Herdr reported: ${JSON.stringify(problems)}`);
  const shot = join(root, "sidebar.png");
  run(herdr, "shot", shot);
  const out = join(repo, "docs", "herdr-app-sidebar.png");
  run(join(root, "img"), "crop", shot, ...SIDEBAR.map(String), out);
  console.log(`Wrote ${out}`);
}

function errors(): unknown[] {
  return JSON.parse(run(herdr, "status")).errors ?? [];
}

async function capture(view: string) {
  writeFileSync(join(mod, "main.js"), mainFor(view));
  await Bun.sleep(1000);
  run(herdr, "do", "mod.open", "--name", "usage-monitor");
  await Bun.sleep(3000);
  const problems = errors();
  if (problems.length) throw new Error(`Herdr reported: ${JSON.stringify(problems)}`);
  const shot = join(root, `${view}.png`);
  run(herdr, "shot", shot);
  run(herdr, "do", "mod.open", "--name", "usage-monitor");

  const img = join(root, "img");
  const out = join(repo, "docs", `herdr-app-${view}.png`);
  run(img, "crop", shot, ...DIALOG.map(String), out);
  console.log(`Wrote ${out}`);
  for (const { from, scale, at } of PREVIEW[view] ?? []) {
    run(img, "paste", shot, ...from.map(String), String(scale), ...at.map(String), preview);
  }
}

setUp();
const app = Bun.spawn([herdr], { env, stdout: "ignore", stderr: "ignore" });
try {
  await waitForWindow();
  await installReadout();
  await capture("allowances");
  await capture("burndown");
  await capture("historical");
  await capturePreviewResets();
  console.log(`Updated ${preview}`);
  await captureSidebar();
} finally {
  Bun.spawnSync([herdr, "do", "app.quit"], { env, stdout: "ignore", stderr: "ignore" });
  if (await Promise.race([app.exited.then(() => true), Bun.sleep(10_000).then(() => false)]) === false) app.kill();
  Bun.spawnSync([hc, "server", "stop"], { env, stdout: "ignore", stderr: "ignore" });
  rmSync(root, { recursive: true, force: true });
}
