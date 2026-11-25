import { expect, test } from "bun:test";
import { claudeCredits, claudeLimitResets, recentCredits } from "../src/fetcher.ts";
import { localTime, timed } from "../herdr-app/mods/usage-monitor/time.js";

const now = Date.parse("2026-11-25T09:30:00Z");

// The usage answer's cedar_ember block, as Anthropic sends it to a recent Claude Code.
const grant = {
  id: "full-reset-2611",
  label: "One full limit reset (November 2026)",
  resets_total: 1,
  resets_left: 1,
  starts_at: "2026-11-10T21:30:00+00:00",
  ends_at: "2026-12-10T22:00:00+00:00",
  clears: ["five_hour", "seven_day", "seven_day_overage_included"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  type: "full",
  unavailable_reason: null,
};

test("limit resets keep the grants still to use, soonest to expire first", () => {
  const later = { ...grant, id: "later", label: "", resets_total: 3, resets_left: 2, ends_at: "2027-01-10T00:00:00Z", use_requires_limit: true };
  const used = { ...grant, id: "used", resets_left: 0 };
  const expired = { ...grant, id: "expired", ends_at: "2026-11-01T00:00:00Z" };
  const resets = claudeLimitResets({ cedar_ember: { eligible: true, grants: [later, used, grant, expired] } }, now);
  expect(resets).toEqual([
    {
      id: "full-reset-2611", label: "One full limit reset (November 2026)", left: 1, total: 1,
      expires_at: "2026-12-10T22:00:00+00:00", usable_now: true, paused: false, needs_limit: false,
    },
    {
      id: "later", label: "Full limit reset", left: 2, total: 3,
      expires_at: "2027-01-10T00:00:00Z", usable_now: true, paused: false, needs_limit: true,
    },
  ]);
});

test("no limit resets when the answer has none or the block is missing", () => {
  // An older Claude Code version is told it isn't eligible, with no grants.
  expect(claudeLimitResets({ cedar_ember: { eligible: false, ineligible_reason: "cli_version", grants: [] } }, now)).toEqual([]);
  expect(claudeLimitResets({ cedar_ember: null }, now)).toEqual([]);
  expect(claudeLimitResets(null, now)).toEqual([]);
});

// prepaid/credits, trimmed to the fields read.
const prepaid = {
  amount: 899,
  currency: "GBP",
  balance: { money: { amount_minor: 899, currency: "GBP", exponent: 2 }, credits: null },
  tranches: [],
  promo_tranches: [{
    remaining_amount_minor_units: 898,
    currency: "GBP",
    expires_at: "2027-08-18T00:00:00Z",
    shown_expires_at: null,
    granted_amount_minor_units: 6176,
    name: null,
  }],
  next_expires_at: "2027-08-18T00:00:00Z",
};

test("the credit balance lists the parts of it that expire, soonest first", () => {
  const bought = { remaining_amount_minor_units: 1, currency: "GBP", expires_at: "2027-12-07T00:00:00Z", name: "Purchase" };
  const spent = { remaining_amount_minor_units: 0, currency: "GBP", expires_at: "2026-12-01T00:00:00Z" };
  expect(claudeCredits({ ...prepaid, tranches: [bought, spent] }, now)).toEqual({
    balance: "£8.99",
    expiring: [
      { amount: "£8.98", expires_at: "2027-08-18T00:00:00Z" },
      { amount: "£0.01", expires_at: "2027-12-07T00:00:00Z", name: "Purchase" },
    ],
  });
});

test("a shown expiry takes the place of the expiry, and past ones are dropped", () => {
  const shown = { ...prepaid.promo_tranches[0], shown_expires_at: "2027-08-17T00:00:00Z" };
  const past = { ...prepaid.promo_tranches[0], expires_at: "2026-11-01T00:00:00Z" };
  expect(claudeCredits({ ...prepaid, promo_tranches: [shown, past] }, now)?.expiring)
    .toEqual([{ amount: "£8.98", expires_at: "2027-08-17T00:00:00Z" }]);
});

test("no credit balance when the account has none or the answer has no amount", () => {
  expect(claudeCredits({ amount: 0, currency: "USD", tranches: [], promo_tranches: [] }, now)).toBeNull();
  expect(claudeCredits({ error: "not_found" }, now)).toBeNull();
  expect(claudeCredits({ amount: 2500, currency: "USD" }, now))
    .toEqual({ balance: "$25.00", expiring: [] });
});

test("a recent credit read is reused for the same account, even one that found no credits", () => {
  const minute = 60_000;
  const claude = { account: "a@example.com", plan: "pro", windows: [] };
  const balance = { balance: "£8.99", expiring: [] };
  expect(recentCredits({ ...claude, credits: null, credits_read_at: now - 5 * minute }, "a@example.com", now))
    .toEqual({ credits: null, read_at: now - 5 * minute });
  expect(recentCredits({ ...claude, credits: balance, credits_read_at: now - 14 * minute }, "a@example.com", now))
    .toEqual({ credits: balance, read_at: now - 14 * minute });
  // Too old, another account, never read, or a read time an older build didn't keep.
  expect(recentCredits({ ...claude, credits: null, credits_read_at: now - 15 * minute }, "a@example.com", now)).toBeUndefined();
  expect(recentCredits({ ...claude, credits: null, credits_read_at: now }, "b@example.com", now)).toBeUndefined();
  expect(recentCredits({ ...claude, credits_read_at: now }, "a@example.com", now)).toBeUndefined();
  expect(recentCredits({ ...claude, credits: balance }, "a@example.com", now)).toBeUndefined();
  expect(recentCredits(null, "a@example.com", now)).toBeUndefined();
});

test("times in another year carry the year, and lowercase labels take the past tense", () => {
  const today = new Date(2026, 10, 25, 9);
  expect(localTime(new Date(2026, 11, 10, 22), false, today)).toBe("Dec 10, 10:00 PM");
  expect(localTime(new Date(2027, 7, 18, 1), false, today)).toBe("Aug 18, 2027, 1:00 AM");
  expect(timed("expires", new Date(Date.now() - 60_000).toISOString())).toStartWith("expired ");
  expect(timed("expires", new Date(Date.now() + 90 * 60_000).toISOString())).toStartWith("expires in 1h 30m · ");
});
