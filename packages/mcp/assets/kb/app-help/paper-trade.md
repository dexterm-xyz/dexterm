---
id: paper-trade
title: Paper trade a coin
kind: app-help
screen: token
feature: paper-ticket
tags:
  - app-help
  - paper
  - trade
  - buy
  - sell
  - ticket
  - simulate
  - practice
keys:
  - B
  - S
actions:
  - trade.buy
  - trade.sell
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

Press `B` / `S` on the token screen to open a PAPER buy/sell ticket in its editing phase. dexterm holds no keys and signs nothing — paper trading is a simulation. Confirming a ticket needs your explicit keypress (the gate); a stray key never confirms. The analyst can open a PAPER ticket but can never size, confirm or send it.

Keys: `B` (token), `S` (token).
