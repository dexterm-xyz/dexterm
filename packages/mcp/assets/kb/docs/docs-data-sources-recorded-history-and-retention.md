---
id: docs-data-sources-recorded-history-and-retention
title: Data sources and rate limits › Recorded history and retention
kind: docs
page: data-sources
page_title: Data sources and rate limits
heading: Recorded history and retention
anchor: recorded-history-and-retention
url: https://dexterm.xyz/docs/data-sources#recorded-history-and-retention
tags:
  - docs
  - data-sources
  - recorded
  - history
  - retention
  - data
  - sources
  - rate
  - limits
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/data-sources.md
date: 2026-10-16
---

What the local recorder keeps, all in your own `--db` file and never uploaded (see the recorder (https://dexterm.xyz/docs/configuration#history-recorder)):

- **Snapshots**: a row per coin when its price, liquidity, holders or volume moved materially (about 5%), or every 30 minutes, while a screen listed it, plus outcome re-checks at 1 h to 72 h after it left. Raw JSON goes after 7 days, rows thin to one per coin per minute after 24 hours, and rows expire after 90 days (`--retention-days D` sets that age).
- **Autotrade ticks** (`autotrade_ticks`, opt-in with `dexterm record run --focus-ticks`): a sample every 5 seconds for coins you hold on paper or have open, every 10 seconds for your watchlist and autotrade candidates: price, liquidity, market cap, 5-minute and 1-hour volume, buys and sells, and price change. At most 60 coins, in DexScreener batches of 30 (never one call per coin, and no Jupiter calls), queued inside the app's own limiter, skipped while DexScreener is rate-limiting, with a daily ceiling of 36,000 calls. Kept 14 days.
- **1m candles** (`autotrade_candles_1m`): open, high, low and close per minute for the same coins, built from those samples, so a high or low is the highest or lowest sample, not every trade. Kept 90 days.
- **Exit probes** (`exit_probes`, opt-in with `dexterm record run --exit-probes`): a Jupiter sell quote of $50 a minute per held coin: SOL out, price impact, route hops or the error. Kept with the ticks; the size cap may evict them.
- **Outcome labels**, verdicts and coin creators: kept.
- **Size cap** (opt-in, `dexterm record run --retention-mb N`): when the database's used space reaches the cap, cached answers more than a day past their expiry are cleared first; if that is not enough, the oldest history (ticks, candles and snapshots, outcome re-checks included) is removed first until it is back under, and recording never pauses; the newest hour is always kept. Without it, the older `--max-db-mb` cap pauses new snapshots instead. SQLite reuses the freed space rather than shrinking the file.
