---
id: docs-live-trading-the-short-version
title: Live trading › The short version
kind: docs
page: live-trading
page_title: Live trading
heading: The short version
anchor: the-short-version
url: https://dexterm.xyz/docs/live-trading#the-short-version
tags:
  - docs
  - live-trading
  - short
  - version
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

> **0.1.7, experimental:** dexterm never holds a key and never signs; live trading happens in the Telegram trading bot of your choice; dexterm 0.1.7 sends alerts and signals to your own bot and does not place orders in it yet; automated order forwarding is next (0.1.8).

- **dexterm never holds a key and never signs a transaction.** It has no trading wallet, no signer and no place to keep a private key. It builds no transaction and sends none.
- **Live trading happens in a Telegram trading bot of your choice.** That bot holds its own wallet and places the orders. You pick it, you fund it, and its rules and fees are its own.
- **dexterm's part is the Telegram connector (https://dexterm.xyz/docs/telegram).** Through your own bot, dexterm sends alerts, signals and run control to your chat. You read them and act in the trading bot yourself.
- **Everything else in dexterm is paper or read-only:** the screener, the analyst, MCP, paper trading (https://dexterm.xyz/docs/paper-trading) and autotrade (https://dexterm.xyz/docs/autotrade) on paper.

> **Not financial advice.** Memecoins rug, pools drain and quotes move. Whatever you trade live, you trade in your trading bot, with money you are ready to lose.
