---
id: docs-autotrade-comparing-them
title: Autotrade (paper) › Several strategies at once › Comparing them
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Comparing them
anchor: comparing-them
url: https://dexterm.xyz/docs/autotrade#comparing-them
tags:
  - docs
  - autotrade
  - comparing
  - them
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

`dexterm autotrade status --all` (and the Q screen's runner view while a parallel run works) shows one row per strategy:

| Column | What it counts |
|---|---|
| ACCOUNT | the paper account it trades from (shown when any strategy uses one) |
| P/L, P/L % | the strategy's paper book against its own bankroll; on a paper account, its own trades against the account's balance |
| WIN, CLOSED | the share of closed trades that made money, next to how many closed |
| OPEN | positions it holds now |
| RUGS, RUG EXP | exits caused by a rug or a liquidity pull, and the share of the money it put in that went into those coins |
| MISSED | coins it saw as candidates, did not enter, that later traded at 2x or more of the price it saw |
| SPEND, $/ENTRY | its model spend, and that spend per entry |

Below the table: one row per paper account (start, equity, cash, P/L, open positions and the strategies on it), the strategies together with each account counted once, and the shared limits in use today. `--json` gives the same numbers for a script. Read the closed-trade counts before the percentages: a few hours of paper trading is not evidence that one strategy is better.
