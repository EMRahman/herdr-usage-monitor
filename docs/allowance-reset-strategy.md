# When to use allowance and when to save a reset

The monitor should recommend an action from the current allowance, the time until each automatic refresh, and the expiry and eligibility of any held reset. It should work from a single reading without predicting future tasks.

Check the 5-hour, account-wide weekly, and model-specific limits that apply to the current model. Compare each window’s percentage of allowance left with its percentage of time left. For example, 14% weekly allowance with one day left is almost exactly on pace. Show both countdowns when recommending a held reset or advising someone to save one.

| What the monitor sees | Recommended action |
|---|---|
| Weekly allowance is ahead of pace and the 5-hour session has room. | **Use the surplus now.** Draw down the current allowance before spending a reset. |
| Weekly allowance is on pace and the session has room. | **Continue at pace.** Keep the held reset. |
| The 5-hour session is exhausted, weekly allowance remains, and the next session refresh comes before any held reset expires. | **Wait for the 5-hour refresh.** Save the reset. |
| Weekly allowance is behind pace, some remains, and there is no pressing reset expiry. | **Pace the remaining balance.** With 8% left and two days to go, the baseline is 4 percentage points per day. |
| The weekly limit is exhausted, the weekly refresh is close, and the held reset stays usable well into next week. | **Wait for the weekly refresh and save the reset.** |
| The weekly limit is exhausted, the refresh is far away, and a held reset covers that limit. | **Use the reset when you next need tokens.** Use the earliest-expiring eligible reset first. |
| A held reset expires at or before the weekly refresh, and weekly allowance remains. | **Use the current balance first.** Flag the expiry deadline. Redeem before expiry if eligible and the refill can be used. |
| A held reset expires at or before the weekly refresh, and the weekly limit is exhausted. | **Use the reset on the next request before expiry.** Waiting for the weekly refresh would lose it. |
| A held reset expires shortly after the weekly refresh and requires hitting a limit to redeem. | **Flag a possible last chance to use it.** If eligible now, redeem when tokens are needed. The automatic refresh may remove eligibility for the rest of the reset’s lifetime. |
| A limit is exhausted and no held reset can clear it. | **Wait for that limit’s automatic refresh.** If multiple limits are exhausted, show when all of them will allow use again. |

An imminent expiry takes priority over ordinary pacing advice. Compare it with the refresh of the limit the reset actually covers. Exclude spent, expired, or paused resets. If expiry is unknown, show that uncertainty before advising someone to save the reset.

**For review.** The current monitor treats a weekly refresh less than three days away as close. Should that remain the cutoff for waiting? How short a gap between the weekly refresh and a held reset’s expiry should trigger the possible-last-chance warning?
