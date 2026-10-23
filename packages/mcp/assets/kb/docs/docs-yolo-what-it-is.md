---
id: docs-yolo-what-it-is
title: Full-port yolo strategy (HIGH RISK, paper) › What it is
kind: docs
page: yolo
page_title: Full-port yolo strategy (HIGH RISK, paper)
heading: What it is
anchor: what-it-is
url: https://dexterm.xyz/docs/yolo#what-it-is
tags:
  - docs
  - yolo
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

`yolo` is an autotrade (https://dexterm.xyz/docs/autotrade) preset for one idea: back one early-momentum entry at a time, take the cost back at about 2x, and let a free bag ride.

> **HIGH RISK. Experimental. Not financial advice.** Most early entries lose, young pairs rug often, and one rug at full size can zero a wallet in a single trade. The paper numbers show how often that happens on your history.

In dexterm, yolo runs on **paper only**. Every fill is simulated on your machine: there is no key, wallet or signer anywhere. If you trade its ideas live, you do it yourself in the Telegram trading bot of your choice (see Live trading (https://dexterm.xyz/docs/live-trading)).

The TUI, the `autotrade list` output, the run banner (also under `autotrade run --all`) and every Telegram start message mark a yolo run **⚠ HIGH RISK**.
