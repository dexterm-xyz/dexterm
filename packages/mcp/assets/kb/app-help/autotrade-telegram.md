---
id: autotrade-telegram
title: Your own Telegram bot for the autotrade runner: notify, control, one-tap approvals (dexterm telegram)
kind: app-help
screen: all
feature: autotrade-telegram
tags:
  - app-help
  - telegram
  - bot
  - phone
  - mobile
  - notify
  - notifications
  - approve
  - approval
  - approvals
  - pair
  - pairing
  - kill
  - pause
  - remote
  - botfather
commands:
  - telegram
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

Create a bot with @BotFather, then run `dexterm telegram setup`: paste the token at the hidden prompt (never as an argument), dexterm checks it and keeps it in your keychain (or the system keyring, or a 0600 file), then shows a 6-digit code; send `/pair <code>` to your bot from your own private chat and confirm the account it shows (@username and id) with `y` on your computer. Pairing is refused while a webhook or another program polls the bot. Only that account in that chat is answered. `dexterm autotrade run <id> --paper` then starts the bot by itself (`--no-telegram` keeps it off): entries, exits, PnL cards, halts and a daily summary reach your phone; `/status`, `/positions`, `/pause`, `/resume` (a pause only), `/kill`, `/flatten` and `/use` (each after a confirm button, `/use` only to an equal-or-tighter strategy; a change it cannot rank counts as looser) and `/approvals on` work from chat, which can make things safer and never less safe. With `entry.decide: "agent+approve"` or approvals on, every entry is a card with [Approve] [Half size] [Skip]: only a button approves, once, for that proposal, your account and your private chat; the price and your limits are checked again at the tap; no answer is a skip. Typed messages are never trades. `dexterm telegram status|test|audit --verify|revoke`. Nothing is hosted; paper only; never send keys or seed phrases in chat. Not financial advice. Full docs: https://dexterm.xyz/docs/telegram/

CLI: `dexterm telegram`.
