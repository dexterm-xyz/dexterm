---
id: docs-autotrade-on-the-q-screen
title: Autotrade (paper) › Strategies and presets › On the Q screen
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: On the Q screen
anchor: on-the-q-screen
url: https://dexterm.xyz/docs/autotrade#on-the-q-screen
tags:
  - docs
  - autotrade
  - screen
  - strategies
  - presets
  - paper
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/autotrade.md
date: 2026-10-16
---

the strategy editor on sample data: a typo in the screen filter is caught at its column while you type

Press `Q` on any screen for AUTOTRADE, paper only. `tab` moves between its views:

- **Strategies**: the presets and your own files with mode, version, content hash and the last backtest (net, drawdown, trades). `n` copies the selected preset under a new id, `d` duplicates any strategy, `⏎` or `e` opens it in the editor, `x` writes it to a shareable file in `~/.dexterm/exports`, and `i` imports a file (always as paper). `o` opens the card of a change the analyst proposed in chat (how that works (https://dexterm.xyz/docs/autotrade#change-a-strategy-by-chat)).
- **Editor**: one form in six sections (entry, exits, risk, sizing, agent, execution). `⏎` changes the selected field (a true/false field flips in place). Every change re-validates the whole strategy and every problem shows next to its field with its path; the screen filter is checked by the screener's own parser while you type, and the column of a mistake is marked. Each exit profile gets a one-line sketch of its stop, take-profits, trails and limits. `s` saves only a valid strategy, as a new version with the change in the journal; `u` undoes your last unsaved change, or, with nothing unsaved, the last saved one (as a new version). The presets open read-only: copy one first.
- **Compare**: `c` on two strategies in the list shows them side by side with the fields that differ first, and `b` backtests both on the same window of recorded history.
- **Backtest**: `b` backtests the selected strategy on the last 14 days of your recorded history and shows the report: trades, win rate with its interval, net, drawdown, the tail numbers, an equity line, results by exit rule, profile and trigger, the size clamps that fired, the refused entries and the limits box. `w` runs a sweep around the default exit profile's own settings with the held-out check described below; its verdict is printed as is. Both run in the background, so the app stays live.
- **Runner**: a running paper runner's heartbeat, any halt, its candidates, sessions, positions and the last lines of its run file; a runner whose heartbeat is more than 30 seconds old shows as stale. `!` stops it, `p` pauses and resumes new entries, and `f` then `y` flattens it (see Stopping it (https://dexterm.xyz/docs/autotrade#stopping-it)).
- **Journey**: `J` on a strategy shows its ladder (draft, backtested, forward-tested, always-on, real) with the evidence for each rung, the forward test running or its report next to the backtest, and any promotion waiting for you. `b` backtests it with the held-out split, `F` starts a 24-hour paper forward test on live data and `X` stops it, `A` then `y` applies a pending always-on promotion. Real is never applied from a key (see build a strategy by chat (https://dexterm.xyz/docs/build-a-strategy-by-chat)).

Nothing on this screen can switch a strategy to live, arm a mandate or touch a wallet or a key: the mode is not an editable field, an import is always paper, and a strategy that says live is refused for backtests.
