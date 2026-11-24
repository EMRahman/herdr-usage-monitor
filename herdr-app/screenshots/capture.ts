// Re-renders the README screenshots and the gallery preview's cards from made-up readings, in a
// throwaway Herdr window. Run it after a change to how the breakdown looks (macOS, with the Herdr
// app installed):
//
//   bun run screenshots
//
// It writes docs/herdr-app-allowances.png, docs/herdr-app-burndown.png, and
// docs/herdr-app-historical.png, and repaints the Claude Allowances and Burndown cards inside
// herdr-app/preview.png. The rest of the preview (its paper, headline, the "spare at this pace"
// callout, and the compact History card) is a fixed design and stays as it is.
//
// Nothing real is read or changed. The window gets its own Herdr home, terminal core, data and
// cache folders, with telemetry off. The mod's bridge is swapped for sample-bridge.js, which
// makes up every reading. The mod's clock is frozen at the sample's time, so every image shows
// the same moment. The window, its core and its folders are removed at the end, even after a
// failure.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SHOT_TIME } from "./sample-bridge.js";

const repo = resolve(import.meta.dir, "..", "..");
const modSource = join(repo, "herdr-app", "mods", "usage-monitor");
const preview = join(repo, "herdr-app", "preview.png");

// The window's size; the breakdown dialog is its middle 90%.
const WIDTH = 1740;
const HEIGHT = 1040;
const DIALOG = [WIDTH * 0.05, HEIGHT * 0.05, WIDTH * 0.9, HEIGHT * 0.9];

// Where each view's Claude card goes in the preview: a rect of the window shot, scaled and placed
// as the preview was laid out. Each rect's edges sit on the card's plain background.
const PREVIEW: Record<string, Array<{ from: number[]; scale: number; at: number[] }>> = {
  allowances: [{ from: [109, 270, 490, 248], scale: 0.895, at: [85.225, 266.02] }],
  burndown: [{ from: [109, 196, 486, 156], scale: 0.825, at: [607.025, 256.15] }], // 5h session
};

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

// The mod's main.js, opening on one view, with its clock frozen at the sample's time.
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
  lines.splice(lastImport + 1, 0, "", `Date.now = () => Date.parse(${JSON.stringify(SHOT_TIME)});`);
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
  await capture("allowances");
  await capture("burndown");
  await capture("historical");
  console.log(`Updated ${preview}`);
} finally {
  Bun.spawnSync([herdr, "do", "app.quit"], { env, stdout: "ignore", stderr: "ignore" });
  if (await Promise.race([app.exited.then(() => true), Bun.sleep(10_000).then(() => false)]) === false) app.kill();
  Bun.spawnSync([hc, "server", "stop"], { env, stdout: "ignore", stderr: "ignore" });
  rmSync(root, { recursive: true, force: true });
}
