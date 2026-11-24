import { expect, test } from "bun:test";
import { latestAllowanceReadAt } from "./herdr-app/mods/usage-monitor/time.js";

test("uses the latest provider reading instead of the time of a cached-only refresh", () => {
  expect(latestAllowanceReadAt({
    timestamp: 9000,
    read_at: { claude: 1000, codex: 2000 },
  })).toBe(2000);
  expect(latestAllowanceReadAt({ timestamp: 9000, read_at: {} })).toBe(0);
});

test("excludes providers that report a sign-in problem", () => {
  expect(latestAllowanceReadAt({
    timestamp: 9000,
    read_at: { claude: 1000, cursor: 9000, grok: 9300 },
    others: [{ id: "cursor", problem: null }, { id: "grok", problem: "expired" }],
  })).toBe(9000);
});
