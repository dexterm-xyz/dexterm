---
id: docs-agents-reading-your-trade-ledger
title: Bring your own agent › Reading your trade ledger
kind: docs
page: agents
page_title: Bring your own agent
heading: Reading your trade ledger
anchor: reading-your-trade-ledger
url: https://dexterm.xyz/docs/agents#reading-your-trade-ledger
tags:
  - docs
  - agents
  - reading
  - trade
  - ledger
  - bring
  - own
  - agent
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/agents.md
date: 2026-10-16
---

Any connected agent can read the trade ledger (https://dexterm.xyz/docs/paper-trading#the-trade-ledger) with the same read-only tools as the rest of the data: `ledger_trades`, `ledger_positions`, `ledger_summary`, `ledger_equity` and `ledger_compare`, plus `candidate_dossier` (what an autotrade run saw and decided about one coin) and `outcomes_lookup` (what a coin, or every candidate of a run, turned into). `trading_status` and `telegram_status` describe your live signer and your Telegram bot: settings and state only, never a key, a seed, an address, an exact balance, a bot token or a chat id.

`backtest_request` lets an agent ask for a longer backtest than `strategy_backtest` runs. It only files the request: you see it with `dexterm autotrade requests` and run or dismiss it yourself, and the agent reads the one-line result with `backtest_requests`.
