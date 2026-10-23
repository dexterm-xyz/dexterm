---
id: chart-trade-markers
title: See your buys and sells on the chart (B / S markers)
kind: app-help
screen: token
feature: chart-trade-markers
tags:
  - app-help
  - markers
  - marker
  - buy
  - sell
  - bought
  - sold
  - fills
  - fill
  - entry
  - exit
  - trades
  - chart
  - avg
  - average
  - paper
  - live
  - arrows
commands:
  - display
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

Every fill of the open coin from your paper ledger (your own and an agent's PAPER trades) and the live ledger (confirmed real swaps) is marked on the token screen's chart and the chart popup, on every timeframe: `B` for a buy and `S` for a sell, at the fill's time and price. Hollow `△ ▽` = PAPER, solid `▲ ▼` = live, so it reads without colour too. Each partial sell gets its own marker (several in one bar show a count), a dashed `avg` line marks the average entry while the position is open, and a closed round trip gets a faint wash from entry to exit. A fill outside the candles on screen is not moved: the chart says how many are off-chart. In the popup, hover a marker for its time, price, size and ledger; `k` or the **MARKERS** button turns them off or on for both charts (saved as `display.chartMarkers`; also `dexterm display markers on|off`). Display only: no marker can arm, size, sign or confirm anything, and nothing is fetched to draw them.

CLI: `dexterm display`.
