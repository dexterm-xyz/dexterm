---
id: docs-yolo-1-replay-it-on-your-own-history
title: Full-port yolo strategy (HIGH RISK, paper) › 1. Replay it on your own history
kind: docs
page: yolo
page_title: Full-port yolo strategy (HIGH RISK, paper)
heading: 1. Replay it on your own history
anchor: 1-replay-it-on-your-own-history
url: https://dexterm.xyz/docs/yolo#1-replay-it-on-your-own-history
tags:
  - docs
  - yolo
  - replay
  - own
  - history
  - full-port
  - strategy
  - high
  - risk
  - paper
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
dexterm autotrade yolo-replay yolo
```

This replays the preset over the history your recorder saved (or `--tape FILE`, `--db PATH --days N`), on paper, with modelled fills, no network and no model. Each entry the rules would take is measured once at the same stake. Then a wallet is compounded through those entries in order, with all of it in each one (the full-port view). It prints:

- the entries, wins, **rugs** and cost recoveries;
- the spread of results per entry, from "rug" to "2x or more";
- the full-port wallet entry after entry, and **the entry where it was zeroed** (at or below 10% of the start);
- 2,000 random runs of 10 entries: **how often it zeroed the wallet**, halved it or doubled it, with the 10th, 50th and 90th percentile.

Every limit of the data prints next to the numbers. Snapshots are not trades, early entries look later than they were, rugs no feed saw are missing (so the rug rate is a floor), the LARP check and the agent are not in a replay, and the random runs assume entries are independent when real ones cluster. A replay is not a forecast. With fewer than 20 entries it says so: read the counts, not the rates.
