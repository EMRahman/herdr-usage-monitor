import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchDetailedReport, getCachedReport, getRateLimitsAsync, type FullReport } from "../src/fetcher.ts";
import { latestModelActivity } from "../src/history/model-usage.ts";
import {
  ACTIVE_POLL_INTERVAL_MS,
  COOLING_POLL_INTERVAL_MS,
  DORMANT_POLL_INTERVAL_MS,
  hasPassedReset,
  isTokenExpired,
  othersTtl,
  planProviderRefreshes,
  providerTtl,
  shouldRefreshProvider,
} from "../src/refresh-policy.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("refresh policy", () => {
  test("providerTtl assigns 3m when active, 15m when cooling, and 60m when dormant", () => {
    expect(providerTtl(NOW, NOW)).toBe(ACTIVE_POLL_INTERVAL_MS);
    expect(providerTtl(NOW - 5 * MINUTE, NOW)).toBe(ACTIVE_POLL_INTERVAL_MS);
    expect(providerTtl(NOW - 14 * MINUTE, NOW)).toBe(ACTIVE_POLL_INTERVAL_MS);

    expect(providerTtl(NOW - 15 * MINUTE, NOW)).toBe(COOLING_POLL_INTERVAL_MS);
    expect(providerTtl(NOW - 60 * MINUTE, NOW)).toBe(COOLING_POLL_INTERVAL_MS);
    expect(providerTtl(NOW - 119 * MINUTE, NOW)).toBe(COOLING_POLL_INTERVAL_MS);

    expect(providerTtl(NOW - 2 * HOUR, NOW)).toBe(DORMANT_POLL_INTERVAL_MS);
    expect(providerTtl(NOW - 8 * HOUR, NOW)).toBe(DORMANT_POLL_INTERVAL_MS);

    expect(providerTtl(undefined, NOW)).toBe(COOLING_POLL_INTERVAL_MS);
    expect(providerTtl(null, NOW)).toBe(COOLING_POLL_INTERVAL_MS);
    expect(providerTtl(0, NOW)).toBe(COOLING_POLL_INTERVAL_MS);
  });

  test("othersTtl never polls faster than 15m and drops to 60m when dormant", () => {
    expect(othersTtl(NOW, NOW)).toBe(COOLING_POLL_INTERVAL_MS);
    expect(othersTtl(NOW - 30 * MINUTE, NOW)).toBe(COOLING_POLL_INTERVAL_MS);
    expect(othersTtl(NOW - 2 * HOUR, NOW)).toBe(DORMANT_POLL_INTERVAL_MS);
    expect(othersTtl(undefined, NOW)).toBe(COOLING_POLL_INTERVAL_MS);
  });

  test("shouldRefreshProvider respects dynamic TTL, attempted_at, cooldown, resets, and force", () => {
    const activePrompt = NOW - 2 * MINUTE;
    const dormantPrompt = NOW - 5 * HOUR;

    // Never read or attempted -> refreshes
    expect(shouldRefreshProvider({ lastActivityAt: activePrompt, now: NOW })).toBe(true);
    expect(shouldRefreshProvider({ lastReadAt: 0, lastActivityAt: dormantPrompt, now: NOW })).toBe(true);

    // Force flag refreshes even if recently read, unless in rate-limit cooldown
    expect(shouldRefreshProvider({ lastReadAt: NOW - 30_000, lastActivityAt: dormantPrompt, now: NOW, force: true })).toBe(true);
    expect(shouldRefreshProvider({
      lastReadAt: NOW - 4 * HOUR,
      lastActivityAt: activePrompt,
      cooldownUntil: NOW + 30 * MINUTE,
      now: NOW,
      force: true,
    })).toBe(false);

    // Active tier: 3m
    expect(shouldRefreshProvider({ lastReadAt: NOW - 2 * MINUTE, lastActivityAt: activePrompt, now: NOW })).toBe(false);
    expect(shouldRefreshProvider({ lastReadAt: NOW - 3 * MINUTE, lastActivityAt: activePrompt, now: NOW })).toBe(true);

    // Dormant tier: 60m
    expect(shouldRefreshProvider({ lastReadAt: NOW - 55 * MINUTE, lastActivityAt: dormantPrompt, now: NOW })).toBe(false);
    expect(shouldRefreshProvider({ lastReadAt: NOW - 60 * MINUTE, lastActivityAt: dormantPrompt, now: NOW })).toBe(true);

    // Failed attempt (old read_at, recent attempted_at) backs off cleanly instead of retrying every minute
    expect(shouldRefreshProvider({
      lastReadAt: NOW - 4 * HOUR,
      lastAttemptAt: NOW - MINUTE,
      lastActivityAt: activePrompt,
      now: NOW,
    })).toBe(false);
    expect(shouldRefreshProvider({
      lastReadAt: NOW - 4 * HOUR,
      lastAttemptAt: NOW - 3 * MINUTE,
      lastActivityAt: activePrompt,
      now: NOW,
    })).toBe(true);

    // Instant wakeup when activity resumes on a dormant provider
    const lastReadDormant = NOW - 15 * MINUTE;
    expect(shouldRefreshProvider({ lastReadAt: lastReadDormant, lastActivityAt: dormantPrompt, now: NOW })).toBe(false);
    expect(shouldRefreshProvider({ lastReadAt: lastReadDormant, lastActivityAt: NOW - 10_000, now: NOW })).toBe(true);

    // Quota window reset wakes up a dormant provider once, and doesn't loop if already attempted after reset
    const resetIso = new Date(NOW - 5 * MINUTE).toISOString();
    expect(hasPassedReset([resetIso], NOW - 20 * MINUTE, NOW)).toBe(true);
    expect(shouldRefreshProvider({
      lastReadAt: NOW - 20 * MINUTE,
      lastActivityAt: dormantPrompt,
      resetsAt: [resetIso],
      now: NOW,
    })).toBe(true);
    expect(shouldRefreshProvider({
      lastReadAt: NOW - 20 * MINUTE,
      lastAttemptAt: NOW - 2 * MINUTE,
      lastActivityAt: dormantPrompt,
      resetsAt: [resetIso],
      now: NOW,
    })).toBe(false);
  });

  test("isTokenExpired applies 60s clock-skew tolerance", () => {
    expect(isTokenExpired(null, NOW)).toBe(false);
    expect(isTokenExpired(undefined, NOW)).toBe(false);
    expect(isTokenExpired(NOW + 10 * MINUTE, NOW)).toBe(false);
    expect(isTokenExpired(NOW - 30_000, NOW)).toBe(false);
    expect(isTokenExpired(NOW - 60_000, NOW)).toBe(true);
    expect(isTokenExpired(NOW - HOUR, NOW)).toBe(true);
  });

  test("planProviderRefreshes reports any=false during cooldown and skips empty others once attempted", () => {
    const cached: FullReport = {
      timestamp: NOW - MINUTE,
      claude: { account: "a", plan: "pro", windows: [{ label: "5h session", used_percent: 10, resets_at: null }], extra_usage: null },
      codex: { account: "a", plan: "plus", windows: [], resets: { available: 0, items: [] } },
      antigravity: { account: "a", groups: [] },
      others: [],
      read_at: {
        claude: NOW - 4 * HOUR,
        codex: NOW - 10 * MINUTE,
        antigravity: NOW - 2 * MINUTE,
      },
      attempted_at: {
        claude: NOW - 4 * HOUR,
        codex: NOW - 10 * MINUTE,
        antigravity: NOW - 2 * MINUTE,
        others: NOW - 10 * MINUTE,
      },
    };
    const plan = planProviderRefreshes(cached, {
      activity: {
        claude: NOW - 2 * MINUTE,
        codex: NOW - 5 * HOUR,
        antigravity: NOW - MINUTE,
      },
      claudeUntil: NOW + 45 * MINUTE,
      now: NOW,
      force: false,
    });
    expect(plan).toMatchObject({
      claude: false,
      codex: false,
      antigravity: false,
      others: false,
      any: false,
    });
    expect(plan.ttls).toMatchObject({
      claude: ACTIVE_POLL_INTERVAL_MS,
      codex: DORMANT_POLL_INTERVAL_MS,
      antigravity: ACTIVE_POLL_INTERVAL_MS,
      others: COOLING_POLL_INTERVAL_MS,
    });
  });
});

describe("latestModelActivity", () => {
  test("retrieves max observed_at by provider from history database", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-test-act-"));
    const dbFile = join(dir, "history.sqlite");
    try {
      const db = new Database(dbFile);
      db.exec(`
        CREATE TABLE model_usage (
          provider TEXT NOT NULL,
          event_id TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          model TEXT NOT NULL,
          PRIMARY KEY (provider, event_id)
        );
        INSERT INTO model_usage VALUES ('claude', 'c1', 1000, 'sonnet');
        INSERT INTO model_usage VALUES ('claude', 'c2', 5000, 'sonnet');
        INSERT INTO model_usage VALUES ('codex', 'x1', 2000, 'o3');
      `);
      db.close();

      expect(latestModelActivity(dbFile)).toEqual({ claude: 5000, codex: 2000 });
      expect(latestModelActivity(join(dir, "nonexistent.sqlite"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fetchDetailedReport adaptive refresh integration", () => {
  function makeTempCache() {
    const dir = mkdtempSync(join(tmpdir(), "herdr-fetch-test-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("refreshes only active providers, skips dormant ones and empty others, and wakes up on resets_at", async () => {
    const { dir, cleanup } = makeTempCache();
    try {
      const calls: string[] = [];
      let otherCalls = 0;
      const claudeReset = new Date(NOW + 20 * MINUTE).toISOString();
      const codexReset = new Date(NOW + 10 * MINUTE).toISOString();

      const mockFetch = (async (url: string | URL | Request) => {
        const href = String(url);
        calls.push(href);
        if (href.includes("api.anthropic.com/api/oauth/usage")) {
          return jsonResponse({
            five_hour: { utilization: 15, resets_at: claudeReset },
            seven_day: { utilization: 40, resets_at: null },
          });
        }
        if (href.includes("chatgpt.com/backend-api/wham/usage")) {
          return jsonResponse({
            rate_limit: {
              primary_window: { used_percent: 25, reset_at: Math.floor(Date.parse(codexReset) / 1000) },
            },
          });
        }
        if (href.includes("rate-limit-reset-credits")) {
          return jsonResponse({ credits: [] });
        }
        return jsonResponse({}, 404);
      }) as typeof fetch;

      const deps = {
        fetch: mockFetch,
        getClaudeSignIns: async () => [{ source: "test", token: "tok-c", expiresAt: NOW + HOUR, plan: "pro", account: { id: "1", label: "a@b.com" } }],
        getCodexSignIns: async () => [{ source: "test", token: "tok-x", expiresAt: NOW + HOUR, plan: "plus", account: { id: "2", label: "a@b.com" } }],
        getAntigravitySignIns: async () => [],
        fetchOtherProviders: async () => {
          otherCalls += 1;
          return [];
        },
        resolveBinary: () => null,
      };

      // Initial fetch at NOW: all providers run once
      const first = await fetchDetailedReport({
        cacheDir: dir,
        now: NOW,
        activity: { claude: NOW - MINUTE, codex: NOW - 5 * HOUR },
        deps,
      });
      expect(first.read_at?.claude).toBe(NOW);
      expect(first.read_at?.codex).toBe(NOW);
      expect(first.attempted_at?.others).toBe(NOW);
      expect(first.ttl?.claude).toBe(ACTIVE_POLL_INTERVAL_MS);
      expect(first.ttl?.codex).toBe(DORMANT_POLL_INTERVAL_MS);
      expect(otherCalls).toBe(1);

      // 4 minutes later: Claude (active, 3m TTL) refreshes; Codex (dormant, 60m TTL) and empty others (15m TTL) skip!
      calls.length = 0;
      const t4 = NOW + 4 * MINUTE;
      const second = await fetchDetailedReport({
        cacheDir: dir,
        now: t4,
        activity: { claude: t4 - MINUTE, codex: NOW - 5 * HOUR },
        deps,
      });
      expect(calls).toEqual(["https://api.anthropic.com/api/oauth/usage?cedar_ember=1"]);
      expect(otherCalls).toBe(1);
      expect(second.read_at?.claude).toBe(t4);
      expect(second.read_at?.codex).toBe(NOW); // carried over!

      // 11 minutes after NOW: Codex's 5h reset (at NOW + 10m) just passed -> Codex wakes up even though dormant!
      calls.length = 0;
      const t11 = NOW + 11 * MINUTE;
      const third = await fetchDetailedReport({
        cacheDir: dir,
        now: t11,
        activity: { claude: t11 - MINUTE, codex: NOW - 5 * HOUR },
        deps,
      });
      expect(calls.some((u) => u.includes("chatgpt.com/backend-api/wham/usage"))).toBe(true);
      expect(third.read_at?.codex).toBe(t11);
    } finally {
      cleanup();
    }
  });

  test("records attempted_at on failure and skips expired tokens on background polls", async () => {
    const { dir, cleanup } = makeTempCache();
    try {
      let fetchCount = 0;
      const deps = {
        fetch: (async () => {
          fetchCount += 1;
          return jsonResponse({ error: "server_error" }, 500);
        }) as typeof fetch,
        getClaudeSignIns: async () => [{ source: "test", token: "expired-tok", expiresAt: NOW - 5 * MINUTE, plan: "pro" }],
        getCodexSignIns: async () => [{ source: "test", token: "valid-tok", expiresAt: NOW + HOUR, plan: "plus" }],
        getAntigravitySignIns: async () => [],
        fetchOtherProviders: async () => [],
        resolveBinary: () => null,
      };

      // Background poll: Claude's expired token makes ZERO HTTP calls; Codex gets 500 and records attempted_at.
      await fetchDetailedReport({
        cacheDir: dir,
        now: NOW,
        activity: { claude: NOW - MINUTE, codex: NOW - MINUTE },
        deps,
      });
      // Only Codex's 2 endpoints (usage + credits) were called; Claude's expired token was skipped.
      expect(fetchCount).toBe(2);

      const cached = await getCachedReport(HOUR, { allowPartial: true, now: NOW + MINUTE, cacheDir: dir });
      expect(cached?.attempted_at?.claude).toBe(NOW);
      expect(cached?.attempted_at?.codex).toBe(NOW);

      // 1 minute later: plan reports nothing due (prevents 60s retry storm!)
      const plan = planProviderRefreshes(cached, {
        activity: { claude: NOW - MINUTE, codex: NOW - MINUTE },
        now: NOW + MINUTE,
        force: false,
      });
      expect(plan.any).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("persists 429 cooldown and suppresses subsequent refresh plans until expiry", async () => {
    const { dir, cleanup } = makeTempCache();
    try {
      const deps = {
        fetch: (async () => jsonResponse({ error: "rate_limited" }, 429, { "retry-after": "3600" })) as typeof fetch,
        getClaudeSignIns: async () => [{ source: "test", token: "valid-tok", expiresAt: NOW + HOUR, plan: "pro" }],
        getCodexSignIns: async () => [],
        getAntigravitySignIns: async () => [],
        fetchOtherProviders: async () => [],
        resolveBinary: () => null,
      };

      await fetchDetailedReport({
        cacheDir: dir,
        now: NOW,
        activity: { claude: NOW - MINUTE },
        deps,
      });

      const limits = await getRateLimitsAsync(dir);
      expect(limits.claudeUntil).toBe(NOW + HOUR);

      const cached = await getCachedReport(HOUR, { allowPartial: true, now: NOW + 10 * MINUTE, cacheDir: dir });
      const duringCooldown = planProviderRefreshes(cached, {
        activity: { claude: NOW + 9 * MINUTE },
        claudeUntil: limits.claudeUntil,
        now: NOW + 10 * MINUTE,
        force: false,
      });
      expect(duringCooldown.claude).toBe(false);

      const afterCooldown = planProviderRefreshes(cached, {
        activity: { claude: NOW + 9 * MINUTE },
        claudeUntil: limits.claudeUntil,
        now: NOW + HOUR + MINUTE,
        force: false,
      });
      expect(afterCooldown.claude).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("reloads cache before merging so a slower selective poll never overwrites a concurrent forced refresh", async () => {
    const { dir, cleanup } = makeTempCache();
    try {
      let codexPct = 25;
      let claudePct = 10;
      let releaseSlowClaude: (() => void) | null = null;
      let slowClaudeStarted: (() => void) | null = null;
      const slowStartedPromise = new Promise<void>((resolve) => {
        slowClaudeStarted = resolve;
      });

      const makeDeps = (slowClaude: boolean) => ({
        fetch: (async (url: string | URL | Request) => {
          const href = String(url);
          if (href.includes("api.anthropic.com/api/oauth/usage")) {
            if (slowClaude) {
              slowClaudeStarted?.();
              await new Promise<void>((resolve) => {
                releaseSlowClaude = resolve;
              });
            }
            return jsonResponse({ five_hour: { utilization: claudePct, resets_at: null } });
          }
          if (href.includes("chatgpt.com/backend-api/wham/usage")) {
            return jsonResponse({
              rate_limit: { primary_window: { used_percent: codexPct, reset_at: null } },
            });
          }
          if (href.includes("rate-limit-reset-credits")) {
            return jsonResponse({ credits: [] });
          }
          return jsonResponse({}, 404);
        }) as typeof fetch,
        getClaudeSignIns: async () => [{ source: "test", token: "tok-c", expiresAt: NOW + HOUR, plan: "pro", account: { id: "1", label: "a@b.com" } }],
        getCodexSignIns: async () => [{ source: "test", token: "tok-x", expiresAt: NOW + HOUR, plan: "plus", account: { id: "2", label: "a@b.com" } }],
        getAntigravitySignIns: async () => [],
        fetchOtherProviders: async () => [],
        resolveBinary: () => null,
      });

      // Initial seed at NOW
      await fetchDetailedReport({
        cacheDir: dir,
        now: NOW,
        activity: { claude: NOW - MINUTE, codex: NOW - 5 * HOUR },
        deps: makeDeps(false),
      });

      // Start delayed Claude-only background poll at NOW + 4m (Codex skipped because dormant)
      claudePct = 18;
      const tBg = NOW + 4 * MINUTE;
      const bgPoll = fetchDetailedReport({
        cacheDir: dir,
        now: tBg,
        activity: { claude: tBg - MINUTE, codex: NOW - 5 * HOUR },
        deps: makeDeps(true),
      });
      await slowStartedPromise;

      // While background poll is mid-flight, a forced refresh saves fresh Codex (42%) and Claude (20%) at NOW + 5m
      claudePct = 20;
      codexPct = 42;
      const tForce = NOW + 5 * MINUTE;
      await fetchDetailedReport({
        cacheDir: dir,
        now: tForce,
        force: true,
        activity: { claude: tForce - MINUTE, codex: NOW - 5 * HOUR },
        deps: makeDeps(false),
      });

      // Now let the slower background poll finish and merge
      releaseSlowClaude!();
      const merged = await bgPoll;

      // Both Codex (skipped by bgPoll) and Claude (older timestamp in bgPoll) must preserve the newer forced refresh!
      expect(merged.codex?.windows[0]?.used_percent).toBe(42);
      expect(merged.read_at?.codex).toBe(tForce);
      expect(merged.claude?.windows[0]?.used_percent).toBe(20);
      expect(merged.read_at?.claude).toBe(tForce);
      expect(merged.attempted_at?.codex).toBe(tForce);
      expect(merged.timestamp).toBe(tForce);

      const saved = await getCachedReport(HOUR, { allowPartial: true, now: tForce + MINUTE, cacheDir: dir });
      expect(saved?.codex?.windows[0]?.used_percent).toBe(42);
      expect(saved?.read_at?.codex).toBe(tForce);
    } finally {
      cleanup();
    }
  });

  test("preserves multiple accounts for the same secondary provider across consecutive and concurrent refreshes", async () => {
    const { dir, cleanup } = makeTempCache();
    try {
      let alicePct = 10;
      let bobPct = 20;
      let releaseSlow: (() => void) | null = null;
      let slowStarted: (() => void) | null = null;
      const slowStartedPromise = new Promise<void>((resolve) => {
        slowStarted = resolve;
      });

      const makeDeps = (slow: boolean) => ({
        fetch: (async () => jsonResponse({}, 404)) as typeof fetch,
        getClaudeSignIns: async () => [],
        getCodexSignIns: async () => [],
        getAntigravitySignIns: async () => [],
        fetchOtherProviders: async () => {
          const snapshot = [
            { id: "copilot", account: "alice", plan: "Pro", windows: [{ kind: "month", scope: "chat", used_percent: alicePct, resets_at: null }], problem: null },
            { id: "copilot", account: "bob", plan: "Pro", windows: [{ kind: "month", scope: "chat", used_percent: bobPct, resets_at: null }], problem: null },
          ];
          if (slow) {
            slowStarted?.();
            await new Promise<void>((resolve) => {
              releaseSlow = resolve;
            });
          }
          return snapshot;
        },
        resolveBinary: () => null,
      });

      // First forced refresh: keeps both alice and bob
      const first = await fetchDetailedReport({ cacheDir: dir, now: NOW, force: true, activity: {}, deps: makeDeps(false) });
      expect(first.others.map((p) => p.account)).toEqual(["alice", "bob"]);

      // Second forced refresh with cache present: must still retain both alice and bob
      alicePct = 15;
      bobPct = 25;
      const second = await fetchDetailedReport({ cacheDir: dir, now: NOW + MINUTE, force: true, activity: {}, deps: makeDeps(false) });
      expect(second.others.map((p) => [p.account, p.windows[0]?.used_percent])).toEqual([["alice", 15], ["bob", 25]]);

      // Concurrent slower refresh (captures 15/25 at NOW+2m) overlapped by a newer refresh (35/45 at NOW+3m)
      const slowPoll = fetchDetailedReport({ cacheDir: dir, now: NOW + 2 * MINUTE, force: true, activity: {}, deps: makeDeps(true) });
      await slowStartedPromise;

      alicePct = 35;
      bobPct = 45;
      await fetchDetailedReport({ cacheDir: dir, now: NOW + 3 * MINUTE, force: true, activity: {}, deps: makeDeps(false) });

      releaseSlow!();
      const merged = await slowPoll;
      expect(merged.others.map((p) => [p.account, p.windows[0]?.used_percent])).toEqual([["alice", 35], ["bob", 45]]);
      expect(merged.read_at?.copilot).toBe(NOW + 3 * MINUTE);
    } finally {
      cleanup();
    }
  });
});
