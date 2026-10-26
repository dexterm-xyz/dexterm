---
id: docs-autotrade-what-it-will-not-do
title: Autotrade (paper) › What it will not do
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: What it will not do
anchor: what-it-will-not-do
url: https://dexterm.xyz/docs/autotrade#what-it-will-not-do
tags:
  - docs
  - autotrade
  - will
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

- **Live money.** A run never signs and never sends a transaction: `--live` and a strategy in live mode are refused, and the runner holds no key. Live trading happens in a Telegram trading bot (or script) of your choice, outside dexterm (see Live trading (https://dexterm.xyz/docs/live-trading)); in real mode (https://dexterm.xyz/docs/real-mode) dexterm sends that executor a signal for each trade and it decides.
- **Copy-trading automation.** It does not copy anyone's trades.
- **Managing anyone else's money.** It runs your strategies on your machine, with your own Claude login and your own paper book. Nobody runs a strategy for you: there are no hosted runners, no pooled accounts, no fee on its trades and no strategy marketplace.
- **Decide outside your rules.** Your agent chooses only inside the bounds you wrote. It cannot raise a size, block an exit, lift a stop or apply a strategy change; you apply a change with a key.
- **Promise results.** Presets are examples, and every backtest prints the limits of its data.

Paper only. Not financial advice.
