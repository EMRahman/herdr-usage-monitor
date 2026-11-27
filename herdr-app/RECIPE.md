# Usage Monitor

Track AI subscription allowances, burndown pace, and historical model & token
usage in Herdr. Compare limits for Claude Code, Codex, Antigravity, Cursor,
GitHub Copilot, Grok, and OpenCode. Click the sidebar readout for reset times,
burndown charts that show how fast each allowance is draining, and local token
history across models.

![Usage Monitor](preview.png)

## What you see

- **The readout** is a 36px block in the sidebar, directly above the
  Settings / Add machine footer, on the sidebar's `chrome` background with a
  1px `border` line above. One 28px row, 8px in from each side, like the
  footer's rows: a 14px gauge icon (`gauge.svg`), then each provider's name
  and % left in 12px text, 8px apart. Names are `muted`, figures are
  `foreground`; a figure at 30% or less is yellow (`ansi3`) and at 10% or less
  red (`blocked`). The icon takes the colour of the lowest figure, `muted`
  when all are healthy and `blocked` on an error.
- **On the folded sidebar rail** (under 160px wide), only the gauge shows,
  centred, with the same colour.
- **The right-hand Usage panel** opens from a **Usage** button at the end of
  the tab bar, after Herdr's Files and Changes and drawn like them (26px,
  6px radius, 12px text, a 14px gauge, `selected` while open). It's our own
  80px block beside Herdr's `tabs` block, the two in a fixed row. macOS only:
  elsewhere the window buttons end the tab bar, so the toggle is a panel
  button beside the readout instead. A right-click on the gauge or
  Cmd+Shift+U also toggles it. The key sends `usage-monitor.panel`, which
  reaches only shown copies: the readout toggles the panel, or the open panel
  closes itself when the readout isn't showing.
- **The panel** is a card like Files and Changes: 10px radius, `background`,
  1px `border`, and a 42px header with "Usage" in semibold, refresh and pin
  icons, and **Details**, which opens the full Burndown dialog. The refresh
  icon (`refresh.svg`, `dim`) asks every provider now, then reloads the
  burndowns; meanwhile it's the `accent` spinner. Its tooltip gives the panel
  provider's sample age, and it's yellow (`ansi3`) once that is 5 minutes old. It stacks the 5-hour and
  weekly burndowns for the focused agent's provider, using the tracked
  account's history. The last provider stays visible when a shell has focus.
  The pin (`dim`, or `selected` while pinned) holds the provider when focus
  moves to another agent; its tooltip says which it's doing. The compact card
  below the charts shows the same provider's remaining allowances, resets,
  and credits. The panel shares Herdr's panel area with Files and Changes.
- **The breakdown** is a dialog covering 90% of the window, `popover`
  background, 12px text:
  - A header with "Usage Monitor" (16px semibold), the `Allowances A | Burndown B | History H` view switcher, and Refresh, Show/Hide readout, and Close buttons (28px high, `raised`).
    The header shows the age of the allowance samples. When ages differ, it
    shows the oldest. Hover for individual sample times. A sample at least five
    minutes old is shown in yellow. During a refresh the button shows a
    spinner and elapsed seconds.
  - An **Untapped allowance** panel across the full width (a card with a green
    border when anything is listed): every untapped window, soonest reset
    first, as `● Claude  5h session ··· 47% left · ≈27% spare · resets in 1h 0m`.
    A legend at the right: ● Untapped ● On pace ● Tight. With nothing
    untapped it says "Nothing is going unused: every allowance is on pace or
    tight."
  - One card per provider (`surface`, 8px radius, 1px `border`), in as many
    columns as fit at 360px or more each; each card goes to the shortest column.
    A card lists its plan, then each limit: a light dot, its name, "N% left" in
    the light's colour, a 4px bar filled to the % left in that colour, a white
    2px tick where an even pace would be, and a caption with the reset
    countdown and time ("Resets in 1h 0m · 12:20 PM", or "Nov 25, 8:58 AM" on
    another day), plus "≈27% spare at this pace" or "≈24% short at this pace".
  - Antigravity groups its limits under each model group's name and models.
    Codex lists its reset credits with their expiry. Claude's Extra usage shows
    the spend and balance with a grey bar and no light.
  - A footer shows history loading progress, partial reports, and errors as needed.

- **Burndown**, the dialog's second view (in the `Allowances | Burndown | History`
  switch beside the title, the chosen one on `selected`): an intro line, then one card
  per provider with a chart for each 5-hour and weekly limit, model-specific
  ones too (Claude's 7d Opus and 7d Sonnet, each Antigravity model group).
  - Each chart has a header like the breakdown's rows (light dot, name,
    "N% left") and the reset countdown, then an 88px plot with a 34px gutter
    of "100% / 50% / 0%" labels and 1px `border` grid lines at those levels.
  - The x axis is the current window: its reset minus its length, to its
    reset. With no reset time (Claude's 5-hour limit before a session), it
    ends now. Under the plot: the start time at left, "Resets <time>" or
    "Now" at right.
  - % left is a step line of 2px `accent` bars with `accent` at 14% opacity
    under it. Time with no readings is a gap. A dotted `muted` diagonal runs
    from 100% at the start to 0% at the reset: an even pace. The time already
    gone in the window (start to now) has a faint `foreground` tint at 3.5%
    opacity behind everything. A 5px `accent` dot marks the end of the last
    allowance step, even when a gap separates it from the current time.
  - Between the step line and the dotted line, a band at 22% opacity shades
    each reading's gap to an even pace: green (`#2fbf71`) where it was ahead,
    yellow (`#d4a72c`) where it was less than 20 points behind, red
    (`#e5534b`) where it was 20 or more behind. Each run is cut at the 48ths
    of the window and measured against the pace at each piece's middle, so
    the band steps down beside the dots. Gaps in the readings stay clear.
  - Hovering the plot shows "3:40 PM · 62% left · even pace 55%" for that
    48th of the window. Claude and Codex tooltips also show the local model
    and reasoning effort combinations logged in that time slice.

- **History** (<kbd>H</kbd>) charts local usage from `history.sqlite` across day, week, month, and year horizons (`D/W/M/Y`). Use `[` / `]` to step through periods and filter by provider or model. A five-stat summary and clickable **Top models** list show totals, period-over-period changes, and reasoning effort mix.
  - Press `G` to cycle between **Both**, **Bars**, and **Line**. Press `I` to switch both graphs between **By model** (top seven models plus **Other**) and **Input & output**. In the split view, `C` includes or excludes the **Prompt cache** series for cache reads and writes.
  - The stacked bars show tokens per interval. The **Usage over time** line graph supports **Per interval** and **Cumulative**. In the split view, the dashed line shows the combined total. Herdr saves the chart selections and filters in `shared("usage-monitor.chartPrefs")`.

## How it behaves

- **Traffic lights.** A window's length comes from its label (5h, 7d / weekly,
  daily, monthly). Its time left as a share of that length is where an even
  pace would put the allowance. More allowance left than time left means
  capacity will go unused:
  - 🟢 **Untapped** (`#2fbf71`): 20 or more points more allowance than time
    left. Also a Codex reset credit expiring within 3 days.
  - 🟡 **On pace** (`#d4a72c`): within 20 points either way.
  - 🔴 **Tight** (`#e5534b`): 10% or less left, or 20 or more points behind,
    so it runs out before the reset.
  - A window with no reset time or unknown length goes by what's left: 70% or
    more is untapped, 25% or less is tight.
  The colours are fixed, not the theme's, so their meaning never changes.
- **Clicking the readout** or **Cmd+U** opens the breakdown; doing it again,
  Esc, Close or a click outside closes it.
- **Refresh** asks every provider now. It's greyed out while a read is running.
- **Keys in the breakdown:** it takes the keyboard when it opens. R refreshes,
  A switches to Allowances (U also works as an alias), B to Burndown, H to
  History, and Space cycles between them (`Shift+Space` reverses); each button
  shows its key in `dim` 10px text, with a Space hint beside the view switch.
  Inside History, D/W/M/Y switch time horizons, `[` / `]` step periods (`T`
  returns to current), `G` cycles `Both | Bars | Line`, and `C` toggles cache
  tokens. Cmd+U and Esc still close it.
- **Polling.** Each copy of the mod checks every 60s. The bridge answers from a
  shared cache and only asks the providers when the cache is 3 minutes old, so
  the readout and breakdown share recent results.
- On start, the readout shows the last cached report (up to a day old) at once,
  then refreshes.
- **Published readings.** After every read, the mod publishes each pool's windows
  as `shared("usage-monitor.windows")` (`contract.js`) for other mods, such as
  Usage Queue: `{ version: 1, readAt, checkedAt, pools: [{ id, provider,
  account, plan, readAt, ttlMs, name?, models?, windows: [{ kind, label,
  leftPct, resetsAt, lengthMs, light }], heldResets? }] }`. Pools are `claude`,
  `codex`, `antigravity/<group>` and the other providers' ids. Raw figures:
  `light` is for display. A pool's `readAt` is null when its age is unknown
  (carried over from an older report); treat it as stale. `checkedAt` is the
  last read, changed or not, so a consumer can tell whether anyone is publishing.
- **Consumers.** A mod that needs current readings writes its id and the time
  into `shared("usage-monitor.consumers")` every minute. While any did in the
  last 3 minutes, the readout keeps polling even when it's hidden.
- **History.** Fresh readings go into `allowance_readings` in
  `~/.local/share/herdr-usage-monitor/history.sqlite` (under `$XDG_DATA_HOME`
  when set). Each row holds a provider, its read time in milliseconds, and
  the limit samples as JSON. Each sample's optional account ID is the first 10 hex digits of the
  account's SHA-256, so each account keeps its own line without the file naming
  it; when a provider has more than one, the charts add the account's name from
  the current report. The report's `read_at` says when each
  provider's figures were read; figures carried over from an older report keep
  their time. A transaction records each provider read time once, and the
  database keeps those readings indefinitely. While Burndown is on screen,
  the dialog reads the last eight days on opening it and after each poll.
- **Model activity.** Normal bridge polls collect recent metadata from the
  local Codex and Claude Code logs. `model_usage` holds the model ID and reasoning
  effort per recorded Codex turn or Claude API response, with a timestamp in
  milliseconds and a hashed event ID. Effort is empty when the log omits it.
  The table is indexed by time and by provider, model, and effort. These rows
  are kept for later analysis. Session log content stays in the source logs.
- Hovering the readout shows the full summary, or the error.

## Built from

- **Layout:** the readout block, `{"id": "usage-monitor", "type": "block", "size":
  {"px": 36}, "content": {"mod": "usage-monitor"}}`, inserted into the sidebar
  column directly before `sidebar-footer`. Herdr's shipped layouts are
  read-only, so it goes into a personal layout: your own, one another mod made
  (`main-context` from context-monitor, say), or a clone of `main`
  (`herdr-app do layout.clone '{"name":"main","as":"herdr-with-usage"}'`).
  The installer also adds `{"id":"usage-monitor-panel","type":"block",
  "content":{"mod":"usage-monitor","props":{"mode":"right-panel"}}}`
  to Herdr's `panel-body` stack when that stack is present inside `panel`.
- **`mods/usage-monitor/`:**
  - `mod.json`: `place: "none"`, a 90% overlay, and a **Usage Monitor** command palette entry.
  - `main.js`: the readout (in a layout block) and the breakdown (as the
    overlay, when `props().overlay` is set). Data lives at module scope, shared
    by both copies; each change calls `setShared("usage-monitor.revision", …)`
    so every copy redraws. Uses `exec`, `readTextFile`, `appHome`, `home`,
    `layout` (to tell the rail), `run("mod.open")`, `closeOverlay`, `setShared`,
    `theme`, `checking`, `cx.timer.every`, `.on_size_change`.
  - `contract.js`: the published readings and the consumer check-in.
  - `breakdown.js`: the dialog. `burndown.js`: the burndown charts. `panel.js`:
    the compact right-hand view and provider selection. `historical.js`:
    the Historical panel (stacked bars, `PathBuilder` line graph, KPIs, filters,
    and model leaderboard). `pace.js`: the traffic-light rules. `time.js`: times,
    durations, and compact token formatting.
  - `bridge.js`: the provider code, prebuilt by `build.ts`. It
    prints `{report, summary, parts}` as JSON: `--cached` returns whatever's
    cached, no flag refreshes providers due under their adaptive activity-based
    TTL (3m active, 15m cooling, 60m dormant, or after a quota reset), and
    `--refresh` asks now.
    `--history` prints `{burndowns, modelUsage}` with allowance runs for each
    limit's current window and timestamped model activity from SQLite.
    `--historical` prints pre-bucketed `D/W/M/Y` token & model analytics from
    SQLite (optionally running one bounded incremental log-sync slice with
    `--sync=1`).
  - `gauge.svg`: the icon.
- **Programs:** Bun runs `bridge.js`. The mod tries `bun` on Herdr's PATH, then
  `config.json`'s `bun` (written by the installer), then `~/.bun/bin/bun`,
  `/opt/homebrew/bin/bun` and `/usr/local/bin/bun`.
- **What it reads:** the bridge reads each provider CLI's local sign-in (Claude
  Code, Codex, Antigravity, Cursor, Copilot, Grok, OpenCode) and asks their
  usage endpoints over the network. It writes its cache to
  `~/.cache/herdr-usage-monitor/` and its history to
  `~/.local/share/herdr-usage-monitor/`.
- **`keys.json`:** binds `cmd-u` to `mod.open:usage-monitor` and `cmd-shift-u`
  to `usage-monitor.panel` (`global`).
- **Optional helper:** the repository's `herdr-app/install.ts` copies the mod,
  writes `config.json`, adds the block and binds the key with `--bind-key`. See
  the repository README.

## Watch out

- **Requests belong to each copy.** Herdr cancels a copy's pending `exec` calls
  when it closes or reloads, so a request shared between copies can never
  settle and blocks the rest. Share the results, not the promise. A busy flag
  older than 50s is treated as left over.
- **Dates are formatted by hand.** Herdr's script runtime ignores
  `toLocaleString`'s options and prints "11/25/2026, 08:58:15 AM".
- **Saving any file in the mod folder reloads it**, including `config.json` and
  `bridge.js`. Write only what changed, and add the layout block last, so the
  readout starts with every file in place.
- **Sharing a layout with other mods:** only insert your block, never wrap other
  nodes. A block showing a mod that is neither yours nor in Herdr's
  `installed.json` belongs to another mod: it isn't a hand edit, and rebuilding
  from `main` puts it back beside the same neighbours.
- The readout fits a 268px sidebar with three providers. Narrower, it clips.
- Cmd+U is macOS. On Linux and Windows use `ctrl-shift-u`. The installer binds
  Cmd+Shift+U for the panel on macOS only, and skips it if the key is taken.
- Needs Bun installed. Providers you're not signed in to are left out.

## Done when

- `herdr-app check herdr-app/mods/usage-monitor` passes from the repository root.
- `bun herdr-app/mods/usage-monitor/bridge.js --cached` prints JSON with a `summary`.
- The readout shows each signed-in provider's % left above Settings within a
  few seconds, and its tooltip shows the full summary.
- Folding the sidebar leaves only the gauge, coloured by the lowest figure.
- Cmd+U and clicking the readout open the breakdown; Cmd+U again closes it.
- Cmd+Shift+U opens the Usage panel; pressing it again closes it.
- A window with much more allowance left than time left shows green and appears
  in Untapped allowance; the tick on its bar sits left of the fill.
- Pressing R or clicking Refresh starts the spinner and stopwatch. The sample
  age stays visible. A manual refresh shows its outcome and duration for five
  seconds. A cached-only refresh shows “No new readings” and the age continues
  from the original sample.
- Closing the breakdown during a refresh, then reopening it, still loads.
- After a few reads, each Burndown line ends with a dot at the last recorded
  allowance level. Hovering the chart shows the reading for that time slice.
