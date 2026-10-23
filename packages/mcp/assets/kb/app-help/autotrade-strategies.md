---
id: autotrade-strategies
title: Autotrade strategies on paper (dexterm autotrade)
kind: app-help
screen: all
feature: autotrade-strategies
tags:
  - app-help
  - autotrade
  - strategy
  - strategies
  - preset
  - presets
  - moonbag
  - scalp
  - swing
  - sweep
  - held-out
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

`dexterm autotrade list|validate|new|import|remove|journal` manages strategy files in ~/.dexterm/strategies (one validated JSON file each, every change in an append-only journal); the presets scalp, swing, runner, moonbag, sample-dip-ladder and yolo (HIGH RISK, see the yolo entry) are read-only, copy one with `dexterm autotrade new <id> --from <preset>`. `dexterm autotrade backtest <id>` replays a strategy over your recorded history with modelled fills and always prints the limits of the data (`--every-candidate`, `--recall 5,10` for tail strategies); `dexterm autotrade sweep <id>` tunes on older coins and checks once on the newest 30% it never saw, with no gain wording unless both halves have 20+ trades and the held-out net is positive. Paper only: a strategy cannot hold a key, wallet or signer section, and a copy in mode live does not run (dexterm holds no key and places no live order). Not financial advice. Full docs: https://dexterm.xyz/docs/autotrade/

CLI: `dexterm autotrade`.
