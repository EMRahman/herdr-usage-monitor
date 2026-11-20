// Bundles the provider code into mods/usage-monitor/bridge.js, so the mod folder works on its
// own: copied into a Herdr home, it needs only Bun. Run after changing the provider code:
//
//   bun herdr-app/build.ts           rebuild bridge.js
//   bun herdr-app/build.ts --check   exit 1 if bridge.js is out of date (for CI or a pre-commit hook)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BRIDGE = join(import.meta.dir, "mods", "usage-monitor", "bridge.js");

export async function bundle(): Promise<Buffer> {
  const outdir = mkdtempSync(join(tmpdir(), "usage-bridge-"));
  try {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "usage-json.ts")],
      target: "bun",
      outdir,
      naming: "bridge.js",
    });
    if (!result.success) {
      throw new Error(`Couldn't bundle the usage bridge:\n${result.logs.map(String).join("\n")}`);
    }
    return readFileSync(join(outdir, "bridge.js"));
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

export function current(): Buffer | null {
  try {
    return readFileSync(BRIDGE);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const next = await bundle();
  const same = current()?.equals(next) ?? false;
  if (process.argv.includes("--check")) {
    if (!same) {
      console.error("herdr-app/mods/usage-monitor/bridge.js is out of date. Run: bun herdr-app/build.ts");
      process.exit(1);
    }
    console.log("bridge.js is up to date.");
  } else if (same) {
    console.log("bridge.js is already up to date.");
  } else {
    await Bun.write(BRIDGE, next);
    console.log("Rebuilt herdr-app/mods/usage-monitor/bridge.js.");
  }
}
