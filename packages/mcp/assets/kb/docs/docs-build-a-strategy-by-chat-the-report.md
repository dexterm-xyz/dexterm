---
id: docs-build-a-strategy-by-chat-the-report
title: Build a strategy by chat › 3. Forward-test it on live data (paper) › The report
kind: docs
page: build-a-strategy-by-chat
page_title: Build a strategy by chat
heading: The report
anchor: the-report
url: https://dexterm.xyz/docs/build-a-strategy-by-chat#the-report
tags:
  - docs
  - build-a-strategy-by-chat
  - report
  - forward-test
  - live
  - data
  - paper
  - build
  - strategy
  - chat
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/build-a-strategy-by-chat.md
date: 2026-10-16
---

`forward report` sets the forward test next to the backtest of the **same rules**, column by column: trades, win rate with its 95% interval, net, max drawdown, rug rate, and the fill cost against the mid price (with the drift from the backtest). It flags a forward win rate outside the backtest's interval, a deeper drawdown and more rugs than the history showed. Under 20 closed forward trades it says plainly that the sample is too small to claim anything, and it allows gain wording only when the backtest passes the evidence rule **and** the forward test made money on 20 or more trades.
