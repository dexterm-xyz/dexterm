---
id: docs-live-trading-real-mode-your-strategy-s-trades-to-your
title: Live trading › Real mode: your strategy's trades to your executor (0.2.0, experimental)
kind: docs
page: live-trading
page_title: Live trading
heading: Real mode: your strategy's trades to your executor (0.2.0, experimental)
anchor: real-mode-your-strategy-s-trades-to-your-executor-0-2-0-experimental
url: https://dexterm.xyz/docs/live-trading#real-mode-your-strategy-s-trades-to-your-executor-0-2-0-experimental
tags:
  - docs
  - live-trading
  - real
  - mode
  - strategy
  - trades
  - executor
  - experimental
  - live
  - trading
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/live-trading.md
date: 2026-10-16
---

In real mode (https://dexterm.xyz/docs/real-mode) a strategy you armed on your own terminal sends every buy and sell it decides to your executor as a LIVE TRADE FIRE signal: a local webhook, a command, a stream file or MCP (a bot cannot read another bot's messages), with a copy in your Telegram chat. Your executor holds the wallet and acts on it; dexterm still holds no key and signs nothing. Hard caps, a kill switch (`dexterm autotrade signal kill`) and receipts of what your executor did are all on your machine. Experimental; not financial advice.
