---
id: docs-going-real-the-digest
title: Going real, safely › The digest
kind: docs
page: going-real
page_title: Going real, safely
heading: The digest
anchor: the-digest
url: https://dexterm.xyz/docs/going-real#the-digest
tags:
  - docs
  - going-real
  - digest
  - going
  - real
  - safely
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/going-real.md
date: 2026-10-16
---

`dexterm autotrade report [--period day|week] [--strategy ID]` prints, for each strategy and mode:
- the closed trades, and the win rate with its 95% interval;
- the net, and the max drawdown;
- refusals, the limits that were hit, and the limits that clamped a size;
- receipts and paper vs real fills;
- your executor's health.

It always ends with a note on the sample size. Five trades say almost nothing, and the interval shows how little.

`--telegram` sends it to your paired chat through your own bot. `--json` prints it as data. `dexterm autotrade report --schedule daily|weekly|off` makes a run with your bot on send it by itself: once a day after local midnight, or on Mondays. It is off by default.
