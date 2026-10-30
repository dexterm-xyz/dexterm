---
id: docs-telegram-what-it-is
title: Telegram (your own bot) › What it is
kind: docs
page: telegram
page_title: Telegram (your own bot)
heading: What it is
anchor: what-it-is
url: https://dexterm.xyz/docs/telegram#what-it-is
tags:
  - docs
  - telegram
  - own
  - bot
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/telegram.md
date: 2026-10-16
---

The autotrade runner can talk to **your own Telegram bot**. You create the bot, you give its token to dexterm on your own computer, and the runner polls Telegram from your computer while it runs. There is no dexterm server in between: nothing is hosted by us, nobody else holds your token, and nothing trades for anyone but you.

It does three things, each one a tier you grant when you pair:

- **Notify** (https://dexterm.xyz/docs/telegram#notify-what-reaches-your-phone): candidates found, entries and exits, a PnL card for every closed trade, halts and guards, spend warnings and a daily summary.
- **Control** (https://dexterm.xyz/docs/telegram#control-the-commands): `/status`, `/positions`, `/pause`, `/resume`, `/kill`, `/flatten`, `/strategies`, `/use` and `/approvals on`. Chat can always make things **safer** and never less safe.
- **Approve** (https://dexterm.xyz/docs/telegram#approve-one-tap-entries): every new entry waits for your tap, with [Approve] [Half size] [Skip] buttons. Only a button approves; a typed message never does.

It runs on **paper**: an approved entry fills on the paper book, with no key, wallet or signer anywhere. This is also dexterm's part in live trading (https://dexterm.xyz/docs/live-trading): dexterm holds no key, and live trades happen in a separate Telegram trading bot of your choice, which holds its own wallet. dexterm sends the alerts and run control to your chat; in this version it does not place orders in that trading bot for you. In real mode (https://dexterm.xyz/docs/real-mode) (0.2.0, experimental) your chat also gets a LIVE TRADE FIRE copy of each signal, and the channels your executor reads are set up in the same file as this bot (`dexterm autotrade signal channels`; `dexterm telegram status` shows them). Experimental, not financial advice.
