---
id: docs-autotrade-rug-proof-entries-experimental
title: Autotrade (paper) › Rug-proof entries (experimental)
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Rug-proof entries (experimental)
anchor: rug-proof-entries-experimental
url: https://dexterm.xyz/docs/autotrade#rug-proof-entries-experimental
tags:
  - docs
  - autotrade
  - rug-proof
  - entries
  - experimental
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

Most of the losses in our own paper testing were creator liquidity pulls on hand-made pools: one transaction, no warning, nothing to sell into afterwards. A pull cannot be front-run, so the main defense is to refuse those pools before entering. Turn it on per strategy with `entry.safety.rugproof` (the defaults below are what `{}` gives you):

```json
"entry": { "safety": { "rugproof": {
  "minPoolAgeMin": 10, "requireSafePool": true, "maxHolderLpPct": 10,
  "maxWithdraws": 0, "withdrawScanTx": 25,
  "liquidityRecheck": { "afterSec": 60, "floorX": 2, "maxDropPct": 15 },
  "routeX": 2, "youngPool": { "underMin": 30, "maxSizePct": 50 },
  "drainGuard": { "pollSec": 10, "liqDropPct": 25, "exitOnNoRoute": true, "minReserveSol": 0.5 }
} } }
```

Before an entry, cheapest first, and **fail closed** (a gate that cannot be read refuses the coin as `-unknown` and looks again in 5 minutes):

- **pool age**: the pool itself is at least `minPoolAgeMin` minutes old. On our paper record this one gate refused all 8 pools that were later pulled and none of the 5 coins that later ran;
- **holders**: top-10 and dev shares under the strategy's own safety limits;
- **a second liquidity read** `afterSec` apart, both well above the exit floor and not falling fast;
- **pool structure**: a pump.fun migration, or a pool whose LP is verifiably burned or locked; a hand-made pool (wrapped SOL as the base mint) is refused, and so is LP held by its creator or by any one wallet over `maxHolderLpPct`;
- **withdraw history**: no liquidity `Withdraw` among the pool's newest transactions (a scan that cannot read every transaction refuses);
- **sell route**: Jupiter returns a token-to-SOL route for `routeX` times the position size.

Young or partly verified pools get at most `youngPool.maxSizePct` of the strategy's size. After an entry, the **drain guard** polls the pool every `pollSec` seconds and sells the whole position at once when liquidity falls more than `liqDropPct` from the entry read, the reserve is near zero, or Jupiter finds no route. Every refusal and exit has a named rule (`rugproof:<gate>`) in the run file and the ledger.

`execution.stuckWriteOffMin` (paper only, refused in any other mode) closes a paper bag that has been unsellable for that many minutes at what could actually be realized, so a dead coin stops holding a slot. In real mode the bag is still in your wallet and keeps its exit signals.

A backtest evaluates only the tick gates (pool age, holders, liquidity) and a pump.fun-mint proxy; the pool, LP, withdraw and route gates need live data. On the history so far, rug-proofing cut the losses a lot and **was still negative per entry**: it loses money more slowly, it does not make a strategy profitable.
