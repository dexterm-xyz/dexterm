---
id: docs-live-trading-using-a-trading-bot-with-dexterm
title: Live trading › Using a trading bot with dexterm
kind: docs
page: live-trading
page_title: Live trading
heading: Using a trading bot with dexterm
anchor: using-a-trading-bot-with-dexterm
url: https://dexterm.xyz/docs/live-trading#using-a-trading-bot-with-dexterm
tags:
  - docs
  - live-trading
  - using
  - trading
  - bot
  - dexterm
  - live
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/live-trading.md
date: 2026-10-16
---

1. Pick a Telegram trading bot you trust, and read its own terms, fees and security advice. Fund its wallet with only what you are ready to lose.
2. Set up dexterm's own bot for your chat: `dexterm telegram setup`, then `dexterm telegram pair`. See Telegram (https://dexterm.xyz/docs/telegram). This is a separate bot that only talks to you.
3. Run a strategy on paper (`dexterm autotrade run <id> --paper`). Its alerts arrive in your chat.
4. When you want to act on one, do it in your trading bot.

dexterm has not been tested with any particular trading bot.
