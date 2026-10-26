---
id: docs-real-mode-where-you-see-it
title: Real mode (LIVE TRADE FIRE signals) › Where you see it
kind: docs
page: real-mode
page_title: Real mode (LIVE TRADE FIRE signals)
heading: Where you see it
anchor: where-you-see-it
url: https://dexterm.xyz/docs/real-mode#where-you-see-it
tags:
  - docs
  - real-mode
  - where
  - real
  - mode
  - live
  - trade
  - fire
  - signals
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/real-mode.md
date: 2026-10-16
---

- **The run**: every fill and closed trade row of a real run is tagged `real-signal` and names its nonce; the start line says REAL; receipts become rows; the end has a `real_halted` row.
- **The `Q` screen's runner view**: the mode, the account, the kill switch, the outbox depth, each channel's health, the unconfirmed positions, the limits in force (with a BUYS PAUSED line when a limit or a silent executor stops new buys) and your executor's health.
- **Telegram**: every message of a real run carries the LIVE badge. A closed trade is a text line (its numbers are dexterm's model, not your executor's fills), never a PnL card.
- **The trade ledger**: `dexterm ledger` lists a real run's trades with the mode `real` (`--mode real`), never `paper`. Their numbers are dexterm's model of each trade it signalled; your executor's receipts are the real fills, so there is no PnL card for them.
- **Shared views**: the spectator stream and saved files keep signals and receipts out.
