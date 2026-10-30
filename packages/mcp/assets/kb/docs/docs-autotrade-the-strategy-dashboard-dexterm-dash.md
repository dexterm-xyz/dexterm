---
id: docs-autotrade-the-strategy-dashboard-dexterm-dash
title: Autotrade (paper) › Several strategies at once › The strategy dashboard (dexterm dash)
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: The strategy dashboard (dexterm dash)
anchor: the-strategy-dashboard-dexterm-dash
url: https://dexterm.xyz/docs/autotrade#the-strategy-dashboard-dexterm-dash
tags:
  - docs
  - autotrade
  - strategy
  - dashboard
  - dexterm
  - dash
  - several
  - strategies
  - once
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

```
dexterm dash                          # http://127.0.0.1:4317/ until Ctrl-C
dexterm dash --json                   # the same numbers, printed
dexterm dash --export DIR --redact-mints   # a static read-only snapshot (the page + data.json)
```

The same run files, in a browser: an overview of every strategy, one strategy in detail (its book over time, drawdown, closed trades), rugs and stuck bags, a comparison against a baseline strategy you pick (`--baseline ID`) with a 95% interval, and live status, refreshed every 30 seconds. `--home DIR` reads another dexterm home (repeat it for several), `--books FILE` adds books your own scripts wrote (`dexterm-dash-books/1`). The server listens on 127.0.0.1 only, makes no network request, loads nothing from the internet and changes nothing; `--allow-host NAME` lets a private proxy you run in front of it answer. Paper results are simulated.
