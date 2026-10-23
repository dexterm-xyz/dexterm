---
id: docs-yolo-3-watch-it-and-stop-it
title: Full-port yolo strategy (HIGH RISK, paper) › 3. Watch it and stop it
kind: docs
page: yolo
page_title: Full-port yolo strategy (HIGH RISK, paper)
heading: 3. Watch it and stop it
anchor: 3-watch-it-and-stop-it
url: https://dexterm.xyz/docs/yolo#3-watch-it-and-stop-it
tags:
  - docs
  - yolo
  - watch
  - stop
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

- **Watch**: the Q screen in the TUI, `dexterm autotrade status`, and your Telegram bot (https://dexterm.xyz/docs/telegram) (entries, exits with their result, halts, the PnL card, all badged PAPER).
- **Stop**: `/kill` from your paired chat, `dexterm autotrade stop`, `dexterm autotrade flatten` (sell everything on paper), or Ctrl-C in the runner. `dexterm wallet panic` halts every run until `dexterm wallet resume`.
- **After**: the run's ledger (`dexterm autotrade audit`) is the record of every candidate, decision and paper fill.
