---
id: docs-configuration-chart-y-axis
title: Configuration and files on disk › Chart Y axis
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Chart Y axis
anchor: chart-y-axis
url: https://dexterm.xyz/docs/configuration#chart-y-axis
tags:
  - docs
  - configuration
  - chart
  - axis
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

Both charts, the terminal token chart and the popup chart (https://dexterm.xyz/docs/popup-chart#market-cap-axis), plot **market cap** on the Y axis by default, for new and existing configs alike. It is separate from the price display mode (https://dexterm.xyz/docs/configuration#price-display-mode): `A` on the token screen (or the popup's **MCAP | PRICE** control) flips the axis between market cap and USD price and saves it as `"display": { "chartAxis": "price" }` (or `"mcap"`; absent means `mcap`) through the journal, so `ctrl+z` undoes it. `dexterm display` prints both settings.

- Axis labels, the last-value tag, the crosshair legend and the volume use one compact formatter: a lowercase k for thousands, then M, B, T; one decimal below 10 of the unit and none after (`$4.9k`, `$42k`, `$487k`, `$1.2M`, `$48M`, `$1.3B`), never scientific notation. When two neighbouring ticks would read the same, the axis adds one decimal (`48.3M`).
- Historical candles are scaled by the **current** supply, and the chart title says `MCAP (current supply)` so nobody reads it as the exact market cap at that time (a burn or a mint since then is not reflected). The bars stay USD prices underneath, so indicators, PAPER entry / stop / target lines and fills keep their meaning; only the labels change.
- A token without a known supply plots its price and the title says `price (mcap unavailable)`. In price mode tiny prices use the subscript form (`0.0₅493`).
- While following an agent, the HUD's PAPER position card reads entry and mark as market cap (`entry MC $4.7k`) when the axis is market cap and the supply is known.
