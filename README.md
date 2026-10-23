# herdr-usage-monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A space-efficient AI subscription allowance monitor for [Herdr](https://herdr.dev).**

Shows live **% remaining** right in Herdr's tab bar (zero extra panels, zero terminal grid waste), with an instant modal overlay (`prefix+u`) for full limit breakdowns and reset countdowns.

Supports Claude Code, OpenAI Codex, Antigravity CLI, Cursor, Grok, and GitHub Copilot.

---

## Highlights

* **Zero extra panels**: Fits cleanly on the right edge of Herdr's existing desktop tab bar (`tab_bar_right`).
* **Inverted to % remaining**: Clearly shows how much allowance you have left (e.g. `Claude 97% (Extra 16%) · Codex 90% · AGY 100%`).
* **Instant on-demand breakdown**: Hit `prefix + u` to open a floating modal popup with progress bars and reset countdowns. Press `q` or `Esc` to close.
* **Fast & lightweight**: Resolves in ~12ms via the local `herdr-web-ui` bridge cache, falling back to direct CLI credential inspection when offline.

---

## Setup in Herdr

Add the following to your Herdr configuration at `~/.config/herdr/config.toml`:

### 1. Tab Bar Status (`tab_bar_right`)

```toml
[ui]
# Desktop tab row placement: "top" or "bottom"
tab_bar_position = "top"

# Show live provider remaining % at the right edge of the tab bar
tab_bar_right = [
  { type = "command", command = "bun /Users/ehsanrahman/Code/herdr-usage-monitor/usage-bar.ts", interval_seconds = 60, timeout_seconds = 2 }
]
tab_bar_right_separator = " · "
```

### 2. On-Demand Modal Breakdown (`keys.command`)

```toml
[[keys.command]]
key = "prefix+u"
type = "popup"
command = "bun /Users/ehsanrahman/Code/herdr-usage-monitor/usage-pane.ts"
description = "Show subscription usage breakdown"
width = "65%"
height = "65%"
```

Then reload Herdr's configuration:
```bash
herdr server reload-config
```

---

## Usage

* **Glance**: Look at the top right of your Herdr terminal window to see your current allowance percentages.
* **Inspect Details**: Press `Ctrl+b` then `u` (or your custom prefix key) to open the modal breakdown.
* **Dismiss Details**: Press `q`, `Esc`, or `Enter` to close the popup and return to your terminal panes.

---

## CLI Commands

You can also run the monitor directly from your shell:

```bash
# Print single-line status for the tab bar
bun usage-bar.ts

# Print full breakdown once to stdout
bun usage-pane.ts --once

# Run interactive terminal viewer (dismiss with q or Esc)
bun usage-pane.ts
```

---

## License

MIT © 2026 Ehsan Rahman
