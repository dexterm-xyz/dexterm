---
id: autotrade
title: Autotrade (paper) strategies, and how to propose a change by chat
tags:
  - autotrade
  - strategy
  - paper
  - backtest
  - proposal
date: 2026-10-24
confidence: high
owner: maintainers
origin: primary-doc
reviewed_by: none
sources:
  - dexterm AUTOTRADE-SPEC §1 (dexterm-strategy/1, exit profiles 1.0.0-1.2.0), §2a (the chat tools and their rules), §3 (backtests)
  - packages/mcp/src/autotrade-tools.ts (deny-list, risk delta, proposals)
---
**What it is.** Autotrade is PAPER only. A strategy is one `dexterm-strategy/1` file: entry (the screener filter grammar, age, safety gates, triggers), exits (exit profiles: stop, take-profit ladder, trails, time stop, thesis breaks, cost recovery, bag trail), sizing, risk limits, agent spend and the fill model. Presets (scalp, swing, runner, moonbag) are read-only; the user's own copies live in `~/.dexterm/strategies`.

**You only propose.** `strategy_propose_edit {id, ops, why}` takes JSON-patch ops (add / replace / remove, at most 20) on a user strategy; `strategy_propose_new {fromPreset, id, name, ops}` makes a paper copy of a preset. Neither applies anything. The user opens the Q screen, presses `o` to see the diff card and `y` to apply. When any risk number gets less safe the proposal is LOOSER and needs a second `y` on the "less safe" popup. Say that plainly; never claim a change is live before the user applied it.

**User-only fields.** `/mode`, `/bankroll`, `/agent/budgetUsdPerDay` and `/execution/minExitLiquidityUsd` are refused (also inside a replaced parent object), as are `/id`, `/version`, `/kind` and `/schema`. A model can never switch a strategy to live or raise its own spend: tell the user they can change those themselves.

**Paths.** Read `strategy_get` first and address its `document`. Profiles are a list: `/exits/profiles/0` may be `"builtin:swing"`; an op reaching into it (for example `/exits/profiles/0/trailingStop/trailPct`) inlines a copy first, automatically.

**Requests into ops (examples).**
- "exit faster" → replace `/exits/profiles/<i>/trailingStop/trailPct` lower (25 → 15) or its `armAtPct` lower.
- "take profit sooner" → lower the `tpLadder` `atPct` steps.
- "add a stop" → replace `hardStop` with `{"enabled": true, "atPct": -25, "why": "…"}`.
- "smaller size" → lower `/sizing/pct` (or `fixedUsd`, `riskPct`) and `/sizing/maxPctOfBankroll`.
- "fewer trades" → lower `/risk/maxEntriesPerDay` or `/risk/maxConcurrent`.
- "stricter coins" → add a screen clause (`top10 <= 25`) or tighten `/entry/safety/*`.
- "stop after a bad day" → lower `/risk/dailyLossHaltPct` or `/risk/drawdown/haltAtPct`.

**Then measure.** `strategy_backtest {proposalId}` runs the current version and the proposal on the same recorded tape (days <= 14, rate-limited; a proposal's backtest saves nothing). `strategy_backtest {id}` also runs the strategy on each half of the held-out split and records it as the strategy's backtest evidence. Quote the trade count and the data limits: small n means little, fills are modelled, and early-entry rugs are often unsellable. A backtest is never a prediction and never financial advice.

**Status.** `autotrade_status` shows the paper runner (heartbeat, halt, candidates, sessions and spend, positions) and the proposals waiting for the user.

**The journey (one rung at a time).** draft → backtested (`strategy_backtest {id}`: held-out split recorded) → forward-tested (`strategy_forward_start {id, hours|trades}`: paper, live data, its own bankroll; read `strategy_forward_report` when it ends; an early stop never counts) → always-on → real (`strategy_promote_propose {id, to}`). `strategy_journey {id}` shows the rungs; evidence binds to the exact rules. Never skip a rung, apply a promotion, set or suggest caps, pick a bankroll or arm anything: say "I proposed it; you apply it". Claim gains only when `heldOut.claim` / `comparison.claim` is true (>= 20 trades in both halves, net above 0); otherwise "too few trades to claim anything".
