import { expect, test } from "bun:test";
import { hasFreshAllowance, refreshDuration, sampleStatus } from "../../herdr-app/mods/usage-monitor/time.js";

const minute = 60_000;
const now = Date.UTC(2026, 10, 24, 12);

test("refresh durations round to the nearest tenth and keep the decimal at whole seconds", () => {
  expect(refreshDuration(0)).toBe("0.0s");
  expect(refreshDuration(100)).toBe("0.1s");
  expect(refreshDuration(949)).toBe("0.9s");
  expect(refreshDuration(950)).toBe("1.0s");
  expect(refreshDuration(1150)).toBe("1.2s");
});

test("sample age advances from the provider timestamp across display boundaries", () => {
  const report = { claude: {}, read_at: { claude: now } };
  for (const [elapsed, label] of [
    [0, "just now"], [minute - 1, "just now"], [minute, "1m ago"], [5 * minute, "5m ago"],
    [10 * minute, "10m ago"], [60 * minute, "1h ago"], [70 * minute, "1h 10m ago"],
    [24 * 60 * minute, "1d ago"],
  ] as const) {
    expect(sampleStatus(report, now + elapsed)).toMatchObject({
      label: `Sampled ${label}`, stale: elapsed >= 5 * minute,
    });
  }
});

test("a fresh provider does not hide an older reading in a mixed report", () => {
  const report = { timestamp: now, claude: {}, codex: {}, read_at: { claude: now - 60 * minute, codex: now } };
  expect(hasFreshAllowance(report)).toBe(true);
  const status = sampleStatus(report, now);
  expect(status.label).toBe("Oldest sample 1h ago");
  expect(status.detail).toContain("Claude · 1h ago");
  expect(status.detail).toContain("Codex · just now");
});

test("retrying from cache and sign-in errors do not reset sample age", () => {
  const report = {
    timestamp: now, others: [{ id: "cursor" }, { id: "grok", problem: "expired" }],
    read_at: { cursor: now - 10 * minute, grok: now },
  };
  expect(hasFreshAllowance(report)).toBe(false);
  expect(sampleStatus(report, now)).toMatchObject({ label: "Sampled 10m ago", stale: true });
});

test("distinguishes legacy report age, missing read times and absent allowances", () => {
  const report = { timestamp: now - 5 * minute, claude: {} };
  expect(sampleStatus(report, now).label).toBe("Cached report 5m ago");
  expect(hasFreshAllowance(report)).toBe(false);
  expect(sampleStatus({ ...report, read_at: {} }, now).label).toBe("Sample age unknown");
  expect(sampleStatus({ ...report, codex: {}, read_at: { codex: now } }, now).label)
    .toBe("Oldest known sample just now");
  expect(sampleStatus(null, now).label).toBe("No samples yet");
});

test("adaptive per-provider TTL prevents dormant idle providers from marking a report stale", () => {
  const report = {
    timestamp: now,
    claude: {},
    codex: {},
    read_at: { claude: now - 2 * minute, codex: now - 40 * minute },
    ttl: { claude: 3 * minute, codex: 60 * minute },
  };
  expect(sampleStatus(report, now)).toMatchObject({ label: "Oldest sample 40m ago", stale: false });
  // Once the active provider passes its 5m threshold, the report turns stale.
  expect(sampleStatus(report, now + 3 * minute).stale).toBe(true);
  // Once the dormant provider passes its 60m TTL + 2m grace (62m), it also turns stale.
  const dormantOverdue = {
    ...report,
    read_at: { claude: now - minute, codex: now - 62 * minute },
  };
  expect(sampleStatus(dormantOverdue, now).stale).toBe(true);
});
