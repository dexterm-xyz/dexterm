---
id: docs-live-trading-stopping
title: Live trading › Stopping
kind: docs
page: live-trading
page_title: Live trading
heading: Stopping
anchor: stopping
url: https://dexterm.xyz/docs/live-trading#stopping
tags:
  - docs
  - live-trading
  - stopping
  - live
  - trading
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/live-trading.md
date: 2026-10-16
---

- `/kill` from your paired chat, `dexterm autotrade stop`, or Ctrl-C in the runner stops a paper run.
- `dexterm wallet panic` engages the kill switch: every autotrade run and the paper agent desk halt, and nothing starts again until `dexterm wallet resume` (a keypress on a real terminal).
- To stop live trades, use your trading bot's own controls. dexterm cannot stop them.
