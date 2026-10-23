---
id: docs-autotrade-several-strategies-at-once
title: Autotrade (paper) › Several strategies at once
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Several strategies at once
anchor: several-strategies-at-once
url: https://dexterm.xyz/docs/autotrade#several-strategies-at-once
tags:
  - docs
  - autotrade
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

`dexterm autotrade run --all --paper` runs every strategy you list in `~/.dexterm/autotrade/autotrade.json` at the same time, on the same live data. Use it to forward-test several ideas side by side: a scalp and a moonbag, or one preset next to your copy of it with a single change.

- **One data feed for all of them.** The screener fetches once and every strategy screens the same coins with its own entry rules, so three strategies do not cost three times the data requests. A coin's dossier is fetched once (at most every 30 seconds), whichever strategy asks for it.
- **Each strategy has its own book.** It gets its own bankroll, run id and run file (`~/.dexterm/autotrade/runs/<run>.jsonl`, hash-chained), loss limits and breaker, candidate sessions and model spend budget. A breaker or a stop on one strategy never stops another. Or let several strategies trade from one paper account (https://dexterm.xyz/docs/autotrade#paper-accounts), the way several bots would share one wallet.
- **Shared limits for all of them.** Model sessions open at once, model spend per day, sessions per day, turns per day, the usage guard of your Claude account and one check of how busy your computer is all count across every strategy. When one of them is reached, every strategy waits.

It is still one runner on your machine: a second `run` (one strategy or `--all`) is refused while it works.
