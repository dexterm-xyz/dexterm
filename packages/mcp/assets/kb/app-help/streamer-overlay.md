---
id: streamer-overlay
title: Streamer overlay for OBS (dexterm overlay)
kind: app-help
screen: all
feature: streamer-overlay
tags:
  - app-help
  - overlay
  - obs
  - stream
  - streamer
  - browser source
  - scene
  - twitch
  - spectator
  - pnl
  - coin card
  - activity
commands:
  - overlay
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

Put the agent session on a live stream. `dexterm overlay` serves three transparent scenes for an OBS Browser source on 127.0.0.1: the agent activity feed, the coin card the agent is on (name, LARP evidence and the deterministic verdict, a top-10 holder bar, the live holder/rug signals) and the PnL card (the same renderer as the H key; stamped PAPER for the agent's simulated fills, or PAPER / LIVE by wallet mode with `--ledger <tradeId>`). `--scene all` puts all three in one source, `--theme cyberspace|ice|neon` picks a preset. It watches the read-only spectator stream a running `dexterm --spectate-mcp` (or `dexterm agent serve --spectate`) opens; `--replay FILE` plays a saved session and every scene then says SAMPLE DATA. Each printed URL works once (a single-use ticket, 10 minutes to paste it; press n for fresh ones). Addresses are always shortened, every scene shows the age of its data, and the overlay can only watch: it sends nothing back and cannot pause, trade, arm or sign. Full docs: https://dexterm.xyz/docs/overlay/

CLI: `dexterm overlay`.
