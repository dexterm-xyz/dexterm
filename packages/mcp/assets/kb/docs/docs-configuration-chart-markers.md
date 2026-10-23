---
id: docs-configuration-chart-markers
title: Configuration and files on disk › Chart markers
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Chart markers
anchor: chart-markers
url: https://dexterm.xyz/docs/configuration#chart-markers
tags:
  - docs
  - configuration
  - chart
  - markers
  - files
  - disk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/configuration.md
date: 2026-10-16
---

Both charts mark your own fills: the terminal token chart and the popup chart (https://dexterm.xyz/docs/popup-chart#buy-and-sell-markers). Every fill of the coin in the paper ledger and the live ledger is a `B` or `S` at its time and price, hollow `△ ▽` for PAPER and solid `▲ ▼` for live, so it reads with `NO_COLOR` too. A dashed `avg` line marks the average entry while a position is open. Markers are on by default; the popup's **MARKERS** control (or `k` in the popup) turns them off and on, and saves `"display": { "chartMarkers": "off" }` (or `"on"`; absent means `on`) through the journal, so `ctrl+z` undoes it. `dexterm display markers [on|off]` shows or sets it from the command line. Display only: nothing that trades reads it.

- The terminal chart puts the glyph and letter on the fill's candle (`△B`, `▽S`; a count when one candle holds several fills), labels the newest marker with its price or market cap, and prints a one-line legend with how many fills are off the chart.
- When the agent HUD or the brain view is up, the brain view's candle trace shows a `B` or `S` cell on each fill's candle, and the agent's PAPER position card marks its fills under its PnL trace.
