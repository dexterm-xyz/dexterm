---
id: docs-autotrade-change-a-strategy-by-chat
title: Autotrade (paper) › Change a strategy by chat
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Change a strategy by chat
anchor: change-a-strategy-by-chat
url: https://dexterm.xyz/docs/autotrade#change-a-strategy-by-chat
tags:
  - docs
  - autotrade
  - change
  - strategy
  - chat
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

Ask the analyst (`a`) to change one of your strategies in plain words, for example "make my swing exit faster" or "fewer entries a day on my copy of moonbag". The analyst can read your strategies and backtest them, but it can only **propose** a change: nothing it says changes a file.

A proposal is a small set of field changes (at most 20) with a one-line reason. Before you see it, dexterm applies it to a copy, validates the result like any strategy, and compares every risk number with the current version:

- **TIGHTER**: at least one risk number got safer and none got less safe.
- **NEUTRAL**: nothing that moves risk changed (a name, a description, a take-profit step).
- **LOOSER**: at least one risk number got less safe: a bigger size or exposure, a higher loss limit, a stop or a trail removed or widened, a safety gate removed, a screen clause dropped, more or costlier agent sessions, or a cheaper fill model.

The proposal shows up as a card on the `Q` screen under PROPOSALS FROM CHAT. `o` opens the newest one (the selected strategy's first) with every changed field, old and new, who proposed it and why:

- `y` applies a tighter or neutral proposal as a new version of the strategy. The change journal records the proposal's id, who proposed it, the change and the content hash before and after.
- A LOOSER proposal needs two keys: the first `y` opens the "less safe" popup that lists every field getting looser, and only a second `y` applies it. Any other key cancels.
- `n` dismisses the proposal; `esc` closes the card and keeps it for later.

Applying checks the proposal again from scratch: if the strategy changed since it was made, it is refused (dismiss it and ask again), and the tighter or looser verdict is worked out again rather than taken from the card.

**What the analyst can never change.** The mode (so it can never switch a strategy to live), the book, the daily session budget and the exit-liquidity floor are yours only: a proposal that touches them, directly or by replacing the section around them, is refused before it reaches you. It cannot apply a proposal or skip the second key either. A shipped preset is read-only, so the analyst proposes a copy under a new id instead, always on paper.

**A backtest next to it.** The analyst can backtest a proposal next to the current version on the same window of your recorded history (up to 14 days). That backtest is read-only (nothing is saved), runs one at a time and is rate-limited, and it carries the limits above (https://dexterm.xyz/docs/autotrade#backtests-and-their-limits): read the number of trades before the totals.

An agent you connect over MCP (`dexterm mcp`) gets the same seven tools under the same rules: `strategy_list`, `strategy_get`, `strategy_validate`, `strategy_propose_edit`, `strategy_propose_new`, `strategy_backtest` and `autotrade_status`. An AI scan (https://dexterm.xyz/docs/scan) session cannot propose at all.

Paper only. Not financial advice.
