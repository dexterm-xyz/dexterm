---
id: turn-on-alerts
title: Turn on alerts (Telegram / Discord / desktop)
kind: app-help
screen: all
feature: push-alerts
tags:
  - app-help
  - alerts
  - alert
  - notify
  - notification
  - telegram
  - discord
  - desktop
  - channel
keys:
  - b
actions:
  - alert.propose
commands:
  - alerts
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

Use `dexterm alerts` to see channels and enable them; `dexterm alerts set-telegram` / `set-discord` store the bot token / webhook in `~/.dexterm/` (mode 0600) — never in config.json, argv or a log. In-app, `b` proposes a liquidity alert on the highlighted coin and `y` arms it. The analyst can never change alert channels or see their secrets.

Keys: `b` (screener). CLI: `dexterm alerts`.
