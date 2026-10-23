---
id: docs-paper-trading-panic
title: Paper trading and the safety model › Panic
kind: docs
page: paper-trading
page_title: Paper trading and the safety model
heading: Panic
anchor: panic
url: https://dexterm.xyz/docs/paper-trading#panic
tags:
  - docs
  - paper-trading
  - panic
  - paper
  - trading
  - safety
  - model
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/paper-trading.md
date: 2026-10-16
---

`/wallet panic` in the app, or `dexterm wallet panic` from any shell, any time: it writes a kill-switch file that every autotrade runner and the paper agent desk re-read on every step, so they halt at once. The only way back is `dexterm wallet resume` in a real terminal: it needs a physical keypress on a TTY and refuses piped input.
