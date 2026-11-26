# When to use allowance and when to save a reset

The monitor should recommend an action from the current allowance, the time until each automatic refresh, and the count, expiry and eligibility of any held reset. It should work from a single reading without predicting future tasks.

Compare each window’s share of allowance used with its share of time elapsed. For example, 86% of the weekly allowance used with one day left is almost exactly on pace. Show both countdowns when recommending a held reset or advising someone to save one.

## Guiding rules

Three core rules govern the advice:

1. **7D nearly all used up, less than 2 days left, and a reset is available:** Don’t use the reset; save it and wait for the weekly refresh.
2. **7D nearly all used up, more than 3 days left, and a reset is available:** Use up the remaining weekly allowance, then redeem the reset.
3. **No resets available:** Stay steady on the 7D pace (% left ÷ days left) so the allowance lasts until the refresh.

The decision table and overrides below expand these guiding rules across all 7D and 5h states, reset counts, and expiry deadlines.

## Bands

| Column | Low | Medium | High |
|---|---|---|---|
| 7D used | under 40% | 40–89% | 90% or more (at or near the limit) |
| Time until 7D refresh | under 2 days | 2–3 days | over 3 days |
| 5h used | under 40% | 40–89% | 90% or more |
| Time until 5h refresh | under 1 hour | 1–3 hours | over 3 hours |

Reset columns count the resets held: **0**, **1** or **>1**. A full reset clears both the 7D and 5h limits. A 5h reset clears only the 5h limit.

Assumptions:

- A reset clears its limits to 0% used and does not move the refresh time.
- A reset can be redeemed once the limit reaches 100%.
- Each reset outlives the next refresh of the limit it covers. Resets that expire sooner are handled by the overrides.

## Decision table

Evaluate rows top to bottom. The first match wins. **≥1** means 1 and >1 give the same action. **Any** means the column does not change the action.

| # | 7D used | 7D time left | 5h used | 5h time left | Full resets (7D + 5h) | 5h-only resets | Suggested action |
|---|---|---|---|---|---|---|---|
| **Weekly at the limit** | | | | | | | |
| 1 | High | Low | Any | Any | 0 or 1 | Any | **Wait for the weekly refresh. Save the reset.** It would refill a week that can be used for under 2 days. A 5h reset can’t clear the weekly limit. |
| 2 | High | Low | Any | Any | >1 | Any | **Wait by default. If tokens are needed before the refresh, redeem one at 100%** and keep at least one. |
| 3 | High | Medium | Any | Any | 1 | Any | **Use the weekly balance to 100%, then redeem only if tokens are needed before the refresh.** Otherwise wait. |
| 4 | High | Medium | Any | Any | >1 | Any | **Use the weekly balance to 100%, then redeem the earliest-expiring reset when tokens are next needed.** |
| 5 | High | High | Any | Any | ≥1 | Any | **Use the weekly balance to 100%, then redeem the earliest-expiring reset when tokens are next needed.** |
| 6 | High | Medium/High | Any | Any | 0 | Any | **Stretch the remainder (% left ÷ days left). At 100%, wait for the weekly refresh.** |
| **Weekly has room, session at the limit** | | | | | | | |
| 7 | Low/Medium | Any | High | Low | Any | Any | **Wait for the 5h refresh (under 1 hour). Save resets.** |
| 8 | Low/Medium | Any | High | Medium/High | Any | ≥1 | **Use the session to 100%, then redeem the earliest-expiring 5h reset if tokens are needed now.** |
| 9 | Low/Medium | Any | High | Medium/High | 0 or 1 | 0 | **Wait for the 5h refresh.** Keep a single full reset for a weekly lockout. |
| 10 | Low/Medium | Any | High | Medium/High | >1 | 0 | **Wait by default. If the work is urgent, redeem one full reset at 100%** and keep at least one for a weekly lockout. |
| **Both have room: pacing** | | | | | | | |
| 11 | Low | Low | Low/Medium | Any | Any | Any | **Weekly allowance is going to waste: use heavily now** and aim to max out each remaining session. |
| 12 | Low | Medium | Low/Medium | Any | Any | Any | **Untapped: use the surplus now.** |
| 13 | Low | High | Low/Medium | Any | Any | Any | **Plenty left early in the week: use freely.** |
| 14 | Medium | Low | Low/Medium | Any | Any | Any | **Untapped: use the surplus now.** It refreshes soon. |
| 15 | Medium | Medium | Low/Medium | Any | Any | Any | **On pace: keep going.** |
| 16 | Medium | High | Low/Medium | Any | 0 | Any | **Spending fast: pace the remainder strictly (% left ÷ days left).** |
| 17 | Medium | High | Low/Medium | Any | 1 | Any | **Spending fast: pace the remainder loosely.** The full reset is a backstop for later in the week. |
| 18 | Medium | High | Low/Medium | Any | >1 | Any | **No need to slow down.** Plan to use the weekly balance to 100% and then redeem one. |

In rows 11–15, if 5h used is Low and its time left is Low, suggest using the session now if work is ready. Its room disappears within the hour.

Keep at least one full reset in reserve for a weekly lockout, unless it is about to expire or a weekly-limit row (rows 3 or 5) advises redeeming it. When several resets qualify, use the earliest-expiring first.

## Overrides

These take priority over the decision table.

| Situation | Action |
|---|---|
| A full reset expires before the 7D refresh | Weekly High: **redeem it at 100% before expiry.** Weekly Low/Medium: **use the balance to 100% before expiry, then redeem.** Flag the deadline. |
| A 5h reset expires before the 5h refresh | Eligible now (5h at 100%): **redeem it now if tokens are needed.** 5h below 100%: **use the session balance to 100% before expiry, then redeem.** Flag the deadline; otherwise it is lost. |
| A full reset needs a limit hit to redeem, expires less than about 2 days after the 7D refresh, and is eligible now | **Last chance: redeem when tokens are next needed.** After the refresh the limit may not be reached again before expiry. |
| More than one full reset is held, and fewer weekly refreshes than resets remain before they expire | **Treat the extras as expiring.** Rows 1, 9 and 15 change from “save” to “use the balance to 100%, then redeem”. |

Exclude spent, expired or paused resets. A reset that needs a limit hit and is not yet usable still counts. If expiry is unknown, treat it as not expiring, but show that uncertainty next to any advice to save the reset.

## For review

- Does a reset keep the refresh time or restart the 7-day clock? If it restarts the clock, rows 1–3 become “use the full reset at 100%”, because timing no longer matters.
- Which limits does each reset type clear? The provider data does not say, so the monitor needs a default.
- Are the band cutoffs right? In particular: the under-2-days “Low” for the 7D refresh, which replaces the current under-3-days cutoff for waiting, and the 2-day last-chance gap.
- Model-specific weekly limits should follow the 7D columns, using whichever weekly limit has the least room.
