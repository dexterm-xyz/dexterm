---
id: autotrade-chat
title: Change an autotrade strategy by chat (paper)
kind: app-help
screen: autotrade
feature: autotrade-chat
tags:
  - app-help
  - autotrade
  - strategy
  - chat
  - analyst
  - proposal
  - tune
  - change
  - diff
  - looser
  - less
  - safe
keys:
  - a
  - o
actions:
  - analyst.toggle
  - autotrade.proposal
tools:
  - strategy_list
  - strategy_get
  - strategy_validate
  - strategy_propose_edit
  - strategy_propose_new
  - strategy_backtest
  - autotrade_status
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

Ask the analyst to change one of your strategies ("make my swing exit faster"). It can only PROPOSE: the change arrives as a card on the AUTOTRADE screen (`Q`) with the field lines that change, the validation result and TIGHTER, NEUTRAL or LOOSER. `o` opens the card, `y` applies it as a new version (journaled with who proposed it), `n` dismisses it. When any risk number gets less safe (bigger size or exposure, more loss, a stop or safety gate removed) the edit is LOOSER and needs a second `y` on the less-safe popup. The mode, the book, the daily session budget and the exit-liquidity floor are yours only: the analyst cannot change them. It can backtest a proposal next to the current version on your recorded history (up to 14 days, read-only). Paper only.

Keys: `a`, `o` (autotrade).
