---
id: docs-yolo-2-run-it-on-paper
title: Full-port yolo strategy (HIGH RISK, paper) › 2. Run it on paper
kind: docs
page: yolo
page_title: Full-port yolo strategy (HIGH RISK, paper)
heading: 2. Run it on paper
anchor: 2-run-it-on-paper
url: https://dexterm.xyz/docs/yolo#2-run-it-on-paper
tags:
  - docs
  - yolo
  - run
  - paper
  - full-port
  - strategy
  - high
  - risk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/yolo.md
date: 2026-10-16
---

```
dexterm autotrade run yolo --paper                                   # live data, paper fills
dexterm autotrade run yolo --paper --replay builtin:yolo-rehearsal   # a short shipped tape, no network for market data
```

To run it next to other strategies, put it in `autotrade.json` and use `dexterm autotrade run --all --paper`, on its own bankroll or on a paper account (https://dexterm.xyz/docs/autotrade#paper-accounts) it shares with others. The LARP check runs there too on live data.
