---
id: autotrade-journey
title: Build a strategy by chat, back-test it, forward-test it, then promote it (paper, then real)
kind: app-help
screen: all
feature: autotrade-journey
tags:
  - app-help
  - autotrade
  - strategy
  - build
  - chat
  - journey
  - ladder
  - backtest
  - held-out
  - forward
  - test
  - promote
  - promotion
  - always-on
  - real
  - evidence
commands:
  - autotrade
tools:
  - strategy_journey
  - strategy_forward_start
  - strategy_forward_stop
  - strategy_forward_report
  - strategy_promote_propose
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

A strategy climbs one ladder, one rung at a time: draft → backtested → forward-tested → always-on (paper) → real. Each rung needs evidence measured on that strategy's exact rules; any rule change starts it again (a rename or arming keeps it). Ask the analyst to build one ("build me a strategy that buys young pairs on a 5-minute push and takes profit at 2x"): it proposes a copy of a preset with changes (strategy_propose_new), you apply it on the Q screen. BACKTESTED: `dexterm autotrade backtest <id>` or strategy_backtest runs it on recorded history and on each half of the held-out split (the newest 30% of coins); verdict rule 6 allows gain wording only with at least 20 trades in both halves and a held-out net above 0. FORWARD-TESTED: `dexterm autotrade forward start <id> --hours 24` (or `--trades N`, or strategy_forward_start from the chat) runs the same version on the LIVE tape, on paper, with its own bankroll and run file, in the background next to the always-on service; `forward status`, `forward stop` and `forward report` (the forward numbers next to the backtest: trades, win rate with its interval, net, drawdown, rug rate, fill cost drift, and a plain line when a sample is too small). Only a test that ran its whole window on live data counts. ALWAYS-ON: the analyst can propose it (strategy_promote_propose), you apply it with `dexterm autotrade promote apply <pp-id>` (y on your own terminal) or on the Q screen journey view (`J`, then `y`); it joins autotrade.json and the always-on service runs it on paper. REAL: you set your own limits (`dexterm autotrade limits set`; `signal caps set` sets four of them), then `dexterm autotrade promote <id> --to real` hands over to `signal arm` (evidence panel, typed phrase with a one-time code). No tool or model can apply a promotion, skip a rung, set a cap, pick a bankroll or arm real mode. `dexterm autotrade journey <id>` shows where a strategy stands. Paper by default; not financial advice.

CLI: `dexterm autotrade`.
