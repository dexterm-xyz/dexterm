---
id: docs-popup-chart-market-cap-axis
title: Popup chart › Market cap axis
kind: docs
page: popup-chart
page_title: Popup chart
heading: Market cap axis
anchor: market-cap-axis
url: https://dexterm.xyz/docs/popup-chart#market-cap-axis
tags:
  - docs
  - popup-chart
  - market
  - cap
  - axis
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

The Y axis shows **market cap by default**. The **MCAP | PRICE** control in the toolbar, `A` or `y` in the popup, or `A` on the terminal's token screen switches it; the terminal saves the choice (`display.chartAxis`, see chart Y axis (https://dexterm.xyz/docs/configuration#chart-y-axis)) and the popup follows within a tick. In market cap the Y axis, the last-value and position-line labels (ENTRY, STOP, TARGET), the EMA / VWAP values and the header read **market cap** in compact form with a lowercase k (`4.9k`, `487k`, `1.2M`, `1.3B`), and the crosshair legend shows the market cap with the price in parentheses (`C 1.2M ($0.0₃12)`). The volume pane stays USD, also compact (`$20k`). In price mode the axis uses the subscript form for tiny prices (`0.0₅493`), never scientific notation. The window title says `mcap (current supply)`: every bar is scaled by today's supply (market cap ÷ price at the latest tick, as the terminal knows it), so older bars are not the exact market cap of their time. The bars themselves stay USD prices, so the entry, stop and target lines and the fill markers keep their meaning; only the labels change. When the coin has no known supply the popup keeps prices and the title says `price (mcap unavailable)`. The position row reads AVG MC / MCAP; profit and loss stay in USD.
