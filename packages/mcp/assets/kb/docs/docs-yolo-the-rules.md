---
id: docs-yolo-the-rules
title: Full-port yolo strategy (HIGH RISK, paper) › The rules
kind: docs
page: yolo
page_title: Full-port yolo strategy (HIGH RISK, paper)
heading: The rules
anchor: the-rules
url: https://dexterm.xyz/docs/yolo#the-rules
tags:
  - docs
  - yolo
  - rules
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

| part | what the preset does |
|---|---|
| entry | pairs 0 to 2 hours old, liquidity $25K or more, 5-minute volume $5K or more, LP 90% or more burned or locked, no mint or freeze authority (`liq >= 25K vol5m >= 5K lplocked >= 90 !flag:mint !flag:freeze`), top-10 at most 30%, dev at most 5%, and a first clean 5-minute push (+3% with buyers 1.3x sellers) |
| LARP check | on live data, the LARP score (https://dexterm.xyz/docs/larp) runs once per coin before it becomes a candidate: above 49 is refused, and a check that cannot run is refused too |
| size | one position at a time. On paper an entry is capped at 25% of the paper book, like every strategy |
| exit | at about +100% sell the slice that pays back the cost; the rest rides on a loose 50% trail. A liquidity pull (30% in 5 minutes), any dev sell, a top holder dumping, dead volume or a market-cap source split exits at once; a -50% stop and a 45-minute time stop (exit if below +20%) end a slow bleed |
| re-entry | never the same coin twice |

A rug or a pulled pool still fills near -100%, whatever the stop says, and a bag that cannot be sold counts as zero.
