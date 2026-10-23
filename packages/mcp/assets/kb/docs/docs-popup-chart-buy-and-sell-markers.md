---
id: docs-popup-chart-buy-and-sell-markers
title: Popup chart › Buy and sell markers
kind: docs
page: popup-chart
page_title: Popup chart
heading: Buy and sell markers
anchor: buy-and-sell-markers
url: https://dexterm.xyz/docs/popup-chart#buy-and-sell-markers
tags:
  - docs
  - popup-chart
  - buy
  - sell
  - markers
  - popup
  - chart
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/popup-chart.md
date: 2026-10-16
---

Every fill of the coin in your ledgers is marked on the chart: the **paper ledger** (your PAPER trades and an agent's PAPER trades) and the **live ledger** (confirmed real swaps from a linked wallet). Nothing is fetched to draw them, and they show whether or not you still hold the coin.

- A buy is a triangle pointing up with `B` under it, its tip on the fill price; a sell points down with `S` above it. **Hollow** triangles (`△ ▽`) are PAPER, **solid** ones (`▲ ▼`) are live, and the colour only adds to that.
- Each fill sits on the bar whose period contains its time, on every timeframe: switch from 1m to 1h and the markers move to their 1h bars. Two fills of one side in one bar make one marker with a count (`S×2`) at their size-weighted price, so a position sold in three parts shows three sells on 1m and fewer, counted ones on 1h. Zoom far out and neighbouring markers merge the same way, so they never pile up.
- Hover a marker for its time, price (market cap with the price in brackets on the market cap axis), size in tokens and SOL, and the ledger it came from. A sell that left tokens says `partial`; the one that closed the position says `closed`.
- While a position is open, the average entry is a dashed line. A closed round trip gets a faint wash from the entry bar to the exit bar (green when it sold above the entry).
- A fill outside the candles on screen is never moved onto another bar. The legend says how many are off the chart and why: older than the first candle, newer than the last one (the candle feed lags a minute or two), or in a minute with no trades.
- **MARKERS** in the toolbar, or `k`, turns them off and on for both charts; the terminal saves it as `display.chartMarkers` (see chart markers (https://dexterm.xyz/docs/configuration#chart-markers)). A fill with no recorded USD price is drawn against its bar and says `price not recorded`.

Display only: no marker can arm, size, sign or confirm anything.
