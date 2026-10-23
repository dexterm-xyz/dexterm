---
id: docs-autotrade-backtests-and-their-limits
title: Autotrade (paper) › Backtests and their limits
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Backtests and their limits
anchor: backtests-and-their-limits
url: https://dexterm.xyz/docs/autotrade#backtests-and-their-limits
tags:
  - docs
  - autotrade
  - backtests
  - their
  - limits
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
dexterm autotrade backtest my-swing               # over your recorder history (read-only)
dexterm autotrade backtest moonbag --every-candidate --recall 5,10
dexterm autotrade sweep scalp                    # tune on older coins, check on the newest ones
dexterm backtest --subject strategy --strategy swing
```

A backtest replays the strategy over the history the recorder (https://dexterm.xyz/docs/data-sources) saved on your machine, with the same entry rules, clamp and exit logic a run would use, and mechanical entries (no agent). It never touches the network or a model. The report gives the trades, wins and losses with a 95% interval on the win rate, the net, the drawdown on marked equity, how many bags could not be sold, and which exit rule, profile and trigger each result came from. Below 20 trades it says to read the counts, not the rates.

For strategies that live on a rare tail, like moonbag, it also prints:

- the **tail**: trades that ended at -80% or worse or could not be sold, how many took their cost back, the net without the single best trade, the result per dollar staked with a bootstrap 95% interval, and the exit-multiple median, 90th percentile and maximum;
- `--every-candidate`: every candidate entered at a fixed $20 with the book's caps lifted, so each entry is an independent sample and the result does not depend on which coins arrived first;
- `--recall 5,10`: of the coins that later ran 5x or 10x, how many the entry rules passed, which rule refused the others, and how each entered one was closed.

**The held-out check.** `sweep` tries a grid of parameters (for example the trail width or the first take-profit). It splits the coins by when they were first seen: the newest 30% are held out, and no coin is in both halves. It tunes on the older coins only, then checks the held-out coins exactly twice, with the unchanged strategy and with the tuned one. It only reports a gain when both halves have at least 20 trades **and** the tuned strategy makes money on the held-out coins. A tuned strategy that only loses less is reported as exactly that.

**Finer history for the coins that matter.** The recorder's snapshots are written on moves of about 5% at the screen's refresh pace, which hides the path a stop or a take-profit lives on. Run the headless recorder with `dexterm record run --focus-ticks` and it also samples the coins you hold on paper or have open every 5 seconds, and your watchlist and autotrade candidates every 10 seconds, with 1-minute candles built from those samples. A backtest reads those samples in time order next to the snapshots, so for those coins a stop fills at the next 5- or 10-second sample instead of the next snapshot. The slower fields (24-hour volume, holders, top-10 share, authorities) come from the coin's latest earlier snapshot, never a later one. Samples are kept 14 days and candles 90 days. With `--retention-mb N` the recorder removes the oldest history to stay under N MB instead of pausing; what is kept and for how long is in recorded history (https://dexterm.xyz/docs/data-sources#recorded-history-and-retention).

**On the history recorded so far, every preset lost money when entered mechanically.** The engine is a way to test your own rules honestly, not a source of profitable ones, and a backtest is not a forecast.

The limits are printed with every report:

- **Coarse prices.** Most of the history is recorder snapshots (written on moves of about 5% or every 30 minutes while a coin was listed), not trades, so stops and take-profits fill at the next recorded price. Coins sampled with `--focus-ticks` are finer (5 to 10 seconds), but a move between two samples is still invisible, and their candles' highs and lows are of the samples, not of every trade.
- **Modelled fills.** Price impact on the recorded pool, plus fee, slippage and network fee; not real quotes.
- **Survivorship.** Only coins the app recorded are in the history; coins nobody saw are absent.
- **Rugs.** A bag below the exit-liquidity floor cannot be sold and counts as zero, and a rug between two snapshots fills at whatever the next snapshot says.
- **Early entries look later than they are.** A young pair enters the history only once a feed lists it, and pairs that rugged before any feed saw them are missing, so the measured rug rate is a floor.
- **Missing signals.** Narrative, followed-wallet, social and dev-sell signals are not in the history, so those triggers and exits never fire in a backtest.
- **No agent.** A backtest has no agent latency and no agent judgement; agent backtests cost Claude usage and stay small.
