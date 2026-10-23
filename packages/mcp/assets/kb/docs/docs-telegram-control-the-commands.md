---
id: docs-telegram-control-the-commands
title: Telegram (your own bot) › Control: the commands
kind: docs
page: telegram
page_title: Telegram (your own bot)
heading: Control: the commands
anchor: control-the-commands
url: https://dexterm.xyz/docs/telegram#control-the-commands
tags:
  - docs
  - telegram
  - control
  - commands
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

The list is closed. Anything else gets the help text.

| command | what it does | from chat |
|---|---|---|
| `/status` | the runner state, strategy, open positions, the day's P/L %, spend, approvals | always |
| `/positions` | each open position with a [Sell] button | always |
| `/pause` | no new entries; exits keep running | always |
| `/resume` | lifts a **pause** | only a pause: never a kill, the panic switch, a loss-limit halt or a guard; those clear on your computer |
| `/kill` (or `/stop`) | the same as `dexterm autotrade stop`: no new entries, sessions closed, pending orders dropped, exits keep running until nothing is held | always |
| `/flatten` | stop, then sell every position at its next tick | after a [Yes, flatten] button |
| `/strategies` | your validated strategies and the presets, marked when `/use` may pick them | always |
| `/use <strategy>` | switch to another strategy | only to one that is **equal or tighter** than the running one, after a [Yes, switch] button. Any change dexterm cannot rank (a field with no safety rule, or a value it cannot compare) counts as looser, and so do a bigger bankroll and a dip-buying ladder. New entries stop at once; the new strategy starts once the open positions have closed. It never changes paper or live |
| `/approvals on` | every new entry waits for your tap | always. `off` is local only: `dexterm telegram approvals off` |

Never from chat, because no such command exists: live mode, looser caps or strategies, approvals off, resuming after a kill or the panic switch, moving funds.

Chat writes the same control file `dexterm autotrade stop` and the AUTOTRADE screen write, so it is a remote control for the runner on your computer and adds no way around its limits. Commands are limited to 10 a minute; `/kill`, `/stop`, `/pause` and `/flatten` are never limited. A command sent while nothing was polling is not acted on when the bot comes back. Commands count only in your private chat, and a forwarded message or one sent through an inline bot is never a command.
