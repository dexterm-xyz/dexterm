---
id: docs-build-a-strategy-by-chat-2-backtest-it-held-out-split
title: Build a strategy by chat › 2. Backtest it (held-out split)
kind: docs
page: build-a-strategy-by-chat
page_title: Build a strategy by chat
heading: 2. Backtest it (held-out split)
anchor: 2-backtest-it-held-out-split
url: https://dexterm.xyz/docs/build-a-strategy-by-chat#2-backtest-it-held-out-split
tags:
  - docs
  - build-a-strategy-by-chat
  - backtest
  - held-out
  - split
  - build
  - strategy
  - chat
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/build-a-strategy-by-chat.md
date: 2026-10-16
---

`dexterm autotrade backtest <id>` (or `b` on the `Q` screen's journey view, or asking the analyst, which calls `strategy_backtest`) runs the strategy on your recorded history, then runs it again on each half of a **held-out split**: the newest 30% of coins, which nothing was ever tuned on, against the rest. The result is recorded as the strategy's backtest evidence.

The evidence rule is strict: gain wording is allowed only with **at least 20 trades in both halves and a held-out net above 0**. Below that the report says "too few trades to claim anything", and the analyst is told to quote the trade counts and nothing more. A backtest is modelled fills on recorded snapshots, not a prediction; its data limits (https://dexterm.xyz/docs/autotrade#backtests-and-their-limits) are printed with it.
