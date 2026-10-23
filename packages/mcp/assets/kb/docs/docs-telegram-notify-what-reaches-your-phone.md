---
id: docs-telegram-notify-what-reaches-your-phone
title: Telegram (your own bot) › Notify: what reaches your phone
kind: docs
page: telegram
page_title: Telegram (your own bot)
heading: Notify: what reaches your phone
anchor: notify-what-reaches-your-phone
url: https://dexterm.xyz/docs/telegram#notify-what-reaches-your-phone
tags:
  - docs
  - telegram
  - notify
  - reaches
  - phone
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

Every message leads with its badge (**PAPER** today) and is plain text: token names are shown as quoted data, passed through the same prompt firewall the analyst uses, with links, addresses, commands and mentions made inert.

| event | default | what it says |
|---|---|---|
| candidates found | a digest every 15 minutes | symbol, short mint, the rules that matched |
| entry and exit | on | size in $ and as % of the book, price, profile, the exit reason, your agent's reason (quoted) |
| trade closed | on | the PnL card image and one line: P/L in % and $, the exit, how long it was held |
| halts and guards | on | the state, the reason, and what clears it |
| spend and usage | on | once a day at 80 % of the day's model spend cap, or of a Claude usage window |
| daily summary | on, 21:00 | trades, wins and losses, the day's P/L in %, open positions, spend, the runner state, approvals |

Shown: the badge, the symbol, a short mint (`abcd…wxyz`), the strategy and its short hash, each trade's size and its share of the book. **Never shown**: keys, the bot token, wallet addresses, wallet balances or the absolute book, file paths. An exit reason or a halt reason that quotes a path, an API key, a long hex value or a keypair shows `[path]`, `[key]` or `[hex]` instead.

Change it locally: `dexterm telegram notify candidates digest|each|off`, `dexterm telegram notify entries|closes|halts|spend|daily on|off`, `dexterm telegram set summary-at 21:00` (or `off`), and `dexterm telegram set quiet 23:00-07:00` (quiet hours hold the notify-only lines; halts, proposals and replies still go). Above 20 messages a minute the bot switches to digests on its own.
