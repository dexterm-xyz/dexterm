---
id: docs-autotrade-confidence-tiers-experimental-unproven-paper-only
title: Autotrade (paper) › Confidence tiers (experimental, unproven, paper only)
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Confidence tiers (experimental, unproven, paper only)
anchor: confidence-tiers-experimental-unproven-paper-only
url: https://dexterm.xyz/docs/autotrade#confidence-tiers-experimental-unproven-paper-only
tags:
  - docs
  - autotrade
  - confidence
  - tiers
  - experimental
  - unproven
  - paper
  - only
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/autotrade.md
date: 2026-10-16
---

**Unproven.** On our held-out data no tier made money, and our November research found no dexterm strategy with a proven edge. This is a way to test a sizing rule on paper; it is not a signal and not a reason to trade real money. Off unless a strategy turns it on, and refused outside paper.

Turn it on per strategy with `sizing.tiers` (paper mode, and the rug-proof block (https://dexterm.xyz/docs/autotrade#rug-proof-entries-experimental) with `minPoolAgeMin` 10 or more):

```json
"sizing": { "tiers": { "table": "v4-1785", "experimental": "paper-only" } }
```

The engine, not the agent, then scores every candidate on two figures from that coin's own tick:

- **turnover1h** = 1 h volume / liquidity, a point at **9.878 or less**;
- **bs5m** = buys / sells over 5 minutes, a point at **3.714 or more**.

Score 0 is **T0, a skip**: no entry. Score 1 is T3, score 2 is T4. **No tier runs above 25% of the book**: the table configures T3 at 75% and T4 at 100%, and both run at 25%. The cap is in the engine's code; no strategy field, table entry or agent answer lifts it, and it also holds across the scale-in tranches of a tiered position. After that every limit you set still applies and the stricter one wins (`maxPctOfBankroll`, `maxUsd`, the profile's max, per-trade loss, exposure, cash, price impact, the drawdown size-down, the rug-proof young-pool cap). The agent can ask for less, never more, and its confidence does not change the tier. One open position at a time unless you add `"oneOpen": false`; an entry still waiting for its fill (the execution latency) or for your approval counts as open, for this and for `maxConcurrent`, and its dollars count against your exposure and cash.

A tier also needs, or it is T0: liquidity of $30,000 or more, a token at least 10 minutes old, not young (under 2 h) and vertical (1 h change of 150% or more), a 1 h change at all for a young coin, and a live tick no older than 5 minutes at the moment of the decision. A missing, negative or non-numeric figure never scores a point.

Paper only, three times over: `dexterm autotrade validate` refuses the block in mode `real` or `live`, the runner refuses it in a real-signal run, and the engine refuses it outside paper.

Where you see it: `dexterm autotrade validate <id>` prints the verdict and every tier with its held-out numbers, `dexterm autotrade list` marks the strategy `EXPERIMENTAL tiers (unproven, paper only)`, every candidate writes a `TIER` line in the run log with its score, size and the verdict, and the ledger's clamp event records the tier.

The table's held-out numbers (frozen before the held-out set was scored once, per entry, 95% interval):

| tier | when | runs at | held-out |
|---|---|---|---|
| T0 | score 0 or a failed gate | skip | 19 entries, mean -17.0% (-35.7% … +3.4%) |
| T3 | score 1 | 25% | 17 entries, mean -7.6% (-31.8% … +16.8%) |
| T4 | score 2 | 25% | no entries (too few to say anything) |
