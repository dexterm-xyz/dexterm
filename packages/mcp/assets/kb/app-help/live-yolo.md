---
id: live-yolo
title: The full-port yolo strategy on paper: replay and a paper run (HIGH RISK)
kind: app-help
screen: all
feature: yolo-preset
tags:
  - app-help
  - yolo
  - full
  - port
  - all-in
  - high
  - risk
  - preset
  - replay
  - paper
commands:
  - autotrade
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

HIGH RISK, PAPER only; not financial advice. The `yolo` preset enters one young pair at a time on an early 5-minute push after the holder-safety gates (LP burned or locked, no mint or freeze authority, a LARP score of 49 or less checked live before a coin becomes a candidate, liquidity of $25K or more), takes the cost back at about 2x, lets the rest ride on a loose 50% trail, exits at once on a liquidity pull, a dev sell or dead volume, has a -50% stop and a 45-minute time stop, and never buys the same coin twice. On paper it caps an entry at 25% like every strategy. `dexterm autotrade yolo-replay yolo` measures every entry at full port over your recorded history (rugs, the loss spread, how often it zeroed the wallet); `dexterm autotrade run yolo --paper` runs it on paper (`--replay builtin:yolo-rehearsal --stub` for a short fixture run; next to other strategies, or on a shared paper account, through `autotrade.json` and `dexterm autotrade run --all --paper`). Stop: `dexterm autotrade stop`, /kill in Telegram, Ctrl-C. dexterm places no live order. Full docs: https://dexterm.xyz/docs/yolo/

CLI: `dexterm autotrade`.
