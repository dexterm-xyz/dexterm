---
id: autotrade-factory
title: The strategy factory: one new paper candidate per run, and strategies on or off by chat
kind: app-help
screen: all
feature: autotrade-factory
tags:
  - app-help
  - autotrade
  - strategy
  - factory
  - generate
  - generated
  - candidate
  - held-out
  - forward
  - retire
  - on
  - off
  - enable
  - disable
  - pause
  - chat
  - schedule
commands:
  - autotrade
tools:
  - strategy_overview
  - factory_status
  - strategy_change
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

The strategy factory (`dexterm autotrade generate`, or `factory run`) asks your own Claude (no tools, a hard spend cap per call) to read every strategy's evidence (entries, mean per entry after modelled costs, its 95% range, at 2x costs, without the top 3, rug rate, forward tests, paper ledgers, lessons.md) and write ONE new paper strategy with a reason for every rule. Cited numbers must match the evidence or the reply is rejected; duplicates (same rules hash) and near copies are refused; it may only change entry rules and exits. The candidate is backtested once on the newest days the model never saw (default 3), written to autotrade/factory/generated/<id>/ (report.json, rationale.md) and queued for a paper forward test (72 h or 200 trades), unless its whole held-out 95% range is below zero: then it is retired at once (kept on disk) and does not take a forward slot (`factory config set forward.skipHeldOutLosers false` queues it anyway); a failed forward test retires it (kept on disk). It is tagged GENERATED on the Q screen; it is never promoted by the factory. Caps: 1 candidate and 3 attempts per run, 5 active candidates, 1 forward test at once, 3 Claude calls and $2 a day, 50 MB (`factory config set`). `factory status` shows the last run, spend and every candidate; `factory stop` writes FACTORY-STOP; `factory install` writes a daily schedule (04:10); an interval that divides the day runs at fixed slots from that time (`factory config set intervalHours 4` = 00:10, 04:10, 08:10 …, away from the nightly tuner), and a scheduled run skips itself while another run holds the lock or the machine has under 4 GB of memory free (minFreeMemMb). `factory run --focus "…"` tells one run what to try. In the chat: "list my strategies" / "which are on" (strategy_overview), "show me the newest generated strategy and why" (factory_status), "turn X off", "retire X", "pause the factory", "run the factory now" (strategy_change: a preview first; it applies only after your own next message says yes). On/off is the PAPER always-on switch of a strategy already in autotrade.json; there is no chat path to real mode, arming, caps or bankrolls. Candidates are not edges; paper and simulated; not financial advice.

CLI: `dexterm autotrade`.
