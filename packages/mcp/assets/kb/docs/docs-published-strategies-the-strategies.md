---
id: docs-published-strategies-the-strategies
title: Published paper strategies › The strategies
kind: docs
page: published-strategies
page_title: Published paper strategies
heading: The strategies
anchor: the-strategies
url: https://dexterm.xyz/docs/published-strategies#the-strategies
tags:
  - docs
  - published-strategies
  - strategies
  - published
  - paper
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/published-strategies.md
date: 2026-10-16
---

| preset | rule, in plain words |
|---|---|
| `ss-s2-old-holders` | Coins at least 6 h old with 2,000+ holders, a 10K USD pool, 5-min volume of 500 USD+ and a 1-h change no worse than -20%, after the holder-safety and pool-safety gates. Cost back at +50%, slices at +200/+400/+900%, the rest on a 40% trail; stop at -32%; out after 45 min unless up 10%. |
| `ss-s2-old-holders-open` | S2 with the gates off. |
| `ss-s3-old-scalp` | Coins at least 6 h old with 500+ holders, a 10K USD pool and 5-min volume of 500 USD+, after the gates. Half off at +30%, a 15% trail once up 20%, stop at -15%, out at 20 minutes. |
| `ss-s3-old-scalp-open` | S3 with the gates off. |
| `ss-t2-trend-hold60` | **Modified.** Pools at least 2 h old with 10K USD liquidity and 5-min volume of 500 USD+, after the gates; hold 60 minutes. The backtest also required a top-trending listing in the last 3 minutes. A strategy file cannot express that filter, so this file trades a wider set of coins than the backtest did. The forward test adds the filter outside the file. |
| `ss-t2-trend-hold60-open` | T2 with the gates off (its own 2 h pool-age floor stays). The same trending caveat applies. |
| `stream-c30-fresh` | Pools 10 min to 6 h old with 15K USD liquidity and 5-min volume of 2K USD+, on a 5-min push of +2% with buyers ahead of sellers, after the gates. 9% of the book in two steps. Stop at -32% until the cost is back, then cost back at +100%, slices at +200/+400/+900% and a free bag on a 40% trail. |
| `stream-c30-trend` | Pairs 6 h to 3 days old with 40K USD liquidity and 5-min volume of 5K USD+, on a 5-min push of +3%; same gates, sizing and exits as fresh pools. |

The **gates** are the holder-safety gates (top-10 holders at most 30% with unknown holders rejected, dev share at most 5%, no mint or freeze authority, no young vertical) and the pool-safety gates (see autotrade (https://dexterm.xyz/docs/autotrade)): the pool is at least 10 minutes old, its LP is migrated, burned or locked, it has had no liquidity withdrawals, a second liquidity read, a sell route, and a drain guard.
