---
id: docs-build-a-strategy-by-chat-5-real-only-if-you-choose
title: Build a strategy by chat › 5. Real, only if you choose
kind: docs
page: build-a-strategy-by-chat
page_title: Build a strategy by chat
heading: 5. Real, only if you choose
anchor: 5-real-only-if-you-choose
url: https://dexterm.xyz/docs/build-a-strategy-by-chat#5-real-only-if-you-choose
tags:
  - docs
  - build-a-strategy-by-chat
  - real
  - only
  - choose
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

Real mode sends each of the strategy's trades as a LIVE TRADE FIRE signal to your own executor; dexterm still holds no key and signs nothing. On this ladder it is the last rung and it is entirely yours:

1. Set your own limits: `dexterm autotrade limits set perTradeSol=X dailySol=Y buysPerDay=N maxOpenPositions=N` and any of the others (Going real, safely (https://dexterm.xyz/docs/going-real#your-limits)); `signal caps set` sets the same four. A promotion to real refuses until you have.
2. Set up a channel your executor reads (`dexterm autotrade signal channels ...`).
3. Have the evidence: a completed forward test of these exact rules with at least 10 closed paper trades (your limit `minForwardTrades`) and a backtest on record. Below that the promotion refuses and says what is missing.
4. `dexterm autotrade promote <id> --to real` (or `promote apply <pp-id>` for one the analyst proposed) hands over to `dexterm autotrade signal arm <id>`: the evidence panel, now with the journey line and the held-out verdict, then a typed phrase with a one-time code.

The analyst can propose real (never below the evidence floor), never apply it, set a cap, choose a bankroll, lower the floor or arm anything. Arming directly with `signal arm` when a rung is missing, or below the evidence floor, refuses unless you type the OVERRIDE phrase it shows on your own terminal; the override is journaled. A real strategy runs in the foreground with `dexterm autotrade run <id> --real`; in 0.2.0 the always-on service runs paper strategies only, so stop the service while a real run is on (one runner per computer). See real mode (https://dexterm.xyz/docs/real-mode).
