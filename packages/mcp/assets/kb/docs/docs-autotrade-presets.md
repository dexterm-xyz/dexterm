---
id: docs-autotrade-presets
title: Autotrade (paper) › Strategies and presets › Presets
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Presets
anchor: presets
url: https://dexterm.xyz/docs/autotrade#presets
tags:
  - docs
  - autotrade
  - presets
  - strategies
  - paper
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/autotrade.md
date: 2026-10-16
---

Six read-only presets ship with dexterm, each on paper (five with a $1,000 paper book, `yolo` with $200):

| preset | the idea |
|---|---|
| `scalp` | young pairs (under 6 h) on a 5-minute push, small take-profits, a hard stop and a short time exit |
| `swing` | pairs from 1 hour to a week old on every screen match, wider take-profits and trail, a review after 90 minutes |
| `runner` | older pairs with deeper liquidity, sized by confidence, a wide trail and a long hold |
| `moonbag` | very young pairs (under 2 h) on an early push, with the holder-safety gates: take the cost back at about 2x, then hold a free bag with a loose trail |
| `sample-dip-ladder` | a shareable example of a custom strategy: risk-sized, buys half and adds half on a dip |
| `yolo` | **HIGH RISK**: one young pair at a time after the holder-safety gates and a live LARP check, the cost back at about 2x, then a free bag; paper only. See Full-port yolo strategy (https://dexterm.xyz/docs/yolo) |

**About moonbag:** most early entries lose. Young pairs rug often, and a rug cannot be sold: once liquidity is pulled, the bag is stuck and counts as zero. The preset therefore uses small tickets and no hard stop, and the point is the rare coin that runs. Read its backtest's tail numbers, never only the total.
