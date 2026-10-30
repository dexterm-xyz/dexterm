---
id: docs-overlay-the-three-scenes
title: Streamer overlay (OBS) › The three scenes
kind: docs
page: overlay
page_title: Streamer overlay (OBS)
heading: The three scenes
anchor: the-three-scenes
url: https://dexterm.xyz/docs/overlay#the-three-scenes
tags:
  - docs
  - overlay
  - three
  - scenes
  - streamer
  - obs
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/overlay.md
date: 2026-10-16
---

| Scene | What it shows | Where the data comes from |
|---|---|---|
| `activity` | The agent's last calls: when, the agent, the tool, a one-line summary, and how old that call's data was | Every call the spectator stream carries |
| `coin` | The coin the agent is on: ticker and shortened mint, price, the deterministic verdict with the rug heuristic, the LARP evidence flags, a top-10 holder bar with the holder count, and the live holder/rug signals, each with its age | The results of the agent's own `get_token`, `get_holders`, `get_dossier`, `analyze_token` and `larp_check` calls, plus the signals your terminal fires for that coin while it follows the agent |
| `pnl` | The PnL card, drawn by the same renderer as the `H` key (PnL cards (https://dexterm.xyz/docs/paper-trading#pnl-cards)) | The agent's PAPER fills on the coin, or one trade from your own ledger with `--ledger` |

`--scene all` puts the three scenes in one Browser source (two columns, the PnL card underneath) if you would rather crop one source than place three.

Every scene shows how old its data is (`data age 12s`, and `… old` next to each figure). The scene's age chip turns yellow once its newest figure is over two minutes old. The LARP line says "evidence, not a verdict", and every page ends with "read-only · addresses redacted · not financial advice".
