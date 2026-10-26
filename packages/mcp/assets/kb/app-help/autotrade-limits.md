---
id: autotrade-limits
title: Set your own real-mode limits: per trade, per day, open positions, loss stops, the breaker (dexterm autotrade limits)
kind: app-help
screen: all
feature: autotrade-limits
tags:
  - app-help
  - limits
  - limit
  - caps
  - cap
  - size
  - sizing
  - per
  - trade
  - daily
  - loss
  - drawdown
  - breaker
  - streak
  - exposure
  - slippage
  - ttl
  - rate
  - raise
  - lower
  - scope
commands:
  - autotrade
tools:
  - trading_limits
  - limits_propose
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

Every limit real mode enforces is yours to set, in one file (`~/.dexterm/autotrade/real/limits.json`, schema `dexterm-limits/1`): per trade as SOL or as % of the book (the smaller wins), SOL and buys per day, open positions, exposure, min and max position, per coin per day, a daily loss stop, a drawdown breaker, a loss-streak pause, max hold time, the evidence floor for arming (`minForwardTrades`: closed paper trades in a completed forward test, placeholder 10), min liquidity and market cap, max slippage and price impact, the signal TTL, a buy rate limit, an optional sell rate (sells are never capped unless you set one) and how long a silent executor may stay silent. `dexterm autotrade limits show [--strategy ID] [--account ID]` lists what is in force and where each number comes from; `limits set perTradeSol=0.5 dailyLossSol=0.3` (or `--scope real|paper|strategy:ID|account:ID`) changes them: a global number replaces the placeholder default, every other scope can only tighten, and the stricter always wins. Paper runs ignore them unless you add a `paper` scope; then a single paper run (not `run --all`) obeys them on its own state (a replay then needs `--sol-usd N`). Daily counters cover the whole home (every strategy and account), so a strategy or account number can only stop buys sooner. Lowering is immediate, even for a running real run; raising shows the old -> new diff and needs the typed phrase on your own terminal, and applies from the next run. `limits diff`, `limits accept` (a hand-edited file), `limits reset`, `limits breaker reset` (typed) and `limits explain` do the rest. The defaults (0.25 SOL a trade, 1 SOL a day, 20 buys, 3 open, stop at -0.5 SOL a day) are placeholders: arming asks for your own numbers first. The analyst can read and explain them (`trading_limits`) and propose a change as a diff card (`limits_propose`); it can never apply one.

CLI: `dexterm autotrade`.
