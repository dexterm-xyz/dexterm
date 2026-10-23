---
id: live-trading
title: Live trading: dexterm holds no key; a Telegram trading bot of your choice trades
kind: app-help
screen: all
feature: live-trading
tags:
  - app-help
  - live
  - trading
  - real
  - money
  - telegram
  - bot
  - key
  - wallet
  - custody
  - signer
  - mainnet
commands:
  - telegram
  - wallet
  - live
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

dexterm never holds a key and never signs or sends a transaction: there is no trading wallet, no signer and no live order in dexterm. Live trading happens in a Telegram trading bot of your choice, which holds its own wallet; you act in that bot. dexterm's part is the Telegram connector to your OWN bot (`dexterm telegram setup`): alerts, signals and run control for your paper runs. dexterm 0.1.7 does not place orders in a trading bot for you. Paper trading (the ticket, paper accounts, paper autotrade) is local. `dexterm wallet link` keeps a Phantom public key for display only. Not financial advice. Full docs: https://dexterm.xyz/docs/live-trading/

CLI: `dexterm telegram`, `dexterm wallet`, `dexterm live`.
