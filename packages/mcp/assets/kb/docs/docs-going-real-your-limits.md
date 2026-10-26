---
id: docs-going-real-your-limits
title: Going real, safely › Your limits
kind: docs
page: going-real
page_title: Going real, safely
heading: Your limits
anchor: your-limits
url: https://dexterm.xyz/docs/going-real#your-limits
tags:
  - docs
  - going-real
  - limits
  - going
  - real
  - safely
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/going-real.md
date: 2026-10-16
---

Every number real mode enforces is yours. They live in one file, `~/.dexterm/autotrade/real/limits.json` (schema `dexterm-limits/1`; `dexterm autotrade limits schema` prints its JSON Schema), outside the model.

**Sizing:**
- `perTradeSol` and `perTradePct`: the most one buy may spend, in SOL or as a percent of the book. With both set, the smaller wins.
- `dailySol` and `buysPerDay`: what all buys may spend, and how many there may be, per local day.
- `maxOpenPositions`: counted across every real holding on this machine.
- `maxExposurePct`: everything open together, as a percent of the book.
- `minPositionSol` and `maxPositionSol`: no dust orders, and a cap on one position with its adds.
- `perCoinSolPerDay` and `perCoinBuysPerDay`: how much one coin may take in a day, re-entries included.
- `bookSol`: the size of YOUR account, which the percent limits use. Unset, they use the strategy's own book.

**Risk:**
- `dailyLossSol`: once the day's realized loss reaches it, no new buy goes out until tomorrow.
- `maxDrawdownSol`: the drawdown breaker. It stops new buys until you reset it with `dexterm autotrade limits breaker reset` (typed). The reset also lifts a loss-streak pause and starts the streak count again.
- `lossStreak` and `lossStreakPauseMin`: that many losing closes in a row pause new buys for that long.
- `maxHoldMinutes`: the stricter of this and each exit profile's own cap.
- `minLiquidityUsd` and `minMcapUsd`: floors on the coin. While one is set, an unknown value is refused.
- `maxSlippageBps` and `maxPriceImpactPct`: the tolerance a signal states. A buy is cut to the price-impact cap on the pool.
- `signalTtlSec`: how long your executor may act on a signal.
- `maxBuysPerMinute`: the signal rate limit.

**Sells:** never capped, unless you set `maxSellsPerMinute`. Only the kill switch stops exits.

**Evidence:** `minForwardTrades`, the evidence floor for arming: the closed paper trades a completed forward test of the strategy's exact rules must have, with a backtest on record. Lowering it or turning it `off` (no trade minimum; the completed forward test and the backtest are still needed) is a raise.

**Executor:** `executorSilenceMin`, how long your executor may be silent before new buys pause (see executor health (https://dexterm.xyz/docs/going-real#executor-health)).

Loss limits are counted on dexterm's own fills: the paper view of every signal.

**Scopes, and the stricter wins.**
- A number in `global` replaces the placeholder default. `off` turns a global limit off, which is a raise.
- `real` / `paper` (a mode), `strategy:<id>` and `account:<id>` can only tighten. Whichever scope sets the stricter number, that number is in force: a smaller cap, or a larger floor.
- Paper runs ignore limits unless you add a `paper` scope. Then a single paper run (`dexterm autotrade run <id> --paper`, a forward test included) obeys them too, the way a real run would, on its own state (it never touches real mode's counters). Limits are in SOL, so a paper replay with a `paper` scope needs `--sol-usd N`. Running several strategies at once (`run --all --paper`) does not apply the paper scope yet.
- The day's counters (buys, SOL spent, realized loss, per coin) count every real buy from this home: all strategies and accounts together. A `strategy:` or `account:` number is compared with that total, so it can only stop buys sooner, never later.

```
dexterm autotrade limits show --strategy my-strategy --account main   # what is in force, and where each number comes from
dexterm autotrade limits set perTradeSol=0.5 dailySol=2 dailyLossSol=0.4
dexterm autotrade limits set --scope strategy:my-strategy perTradePct=2 maxOpenPositions=1
dexterm autotrade limits explain maxExposurePct
```

**Lowering is free and immediate.** A running real run re-reads the file and uses the stricter of what it started with and what the file says now.

**Raising needs you.** `limits set` shows every change old -> new, marks each RAISE, and asks for a typed phrase with a one-time code on your own terminal. A pipe, a flag, an agent or MCP cannot give it. A raise applies from the next run.

**Hand edits.** If you edit `limits.json` by hand, a real run accepts the edit only when it lowers. One that raises anything is refused until you review it (`dexterm autotrade limits diff`) and accept it (`dexterm autotrade limits accept`, typed). Everything is journaled. Caps you set before 0.2.0 (`caps.json`) carry over as your global numbers, unless they differ from what dexterm last saved: then they count as a hand edit too.

**The placeholders** are 0.25 SOL a trade, 1 SOL a day, 20 buys a day, 3 open positions, a stop at -0.5 SOL a day, a pause after 5 losing closes in a row (60 min), at most 3 buys a minute, a pause when your executor is silent for 15 minutes, and an evidence floor of 10 closed paper trades. They are a cautious starting point, not advice. Real mode never arms on them silently: the first arming asks for your own numbers, and every arming shows the limits it confirms.

**The analyst can explain, never apply.** Ask it "why was that buy refused?" or "what would a 1 SOL daily cap change?". It reads the limits (`trading_limits`) and can propose a change as a diff card (`limits_propose`) with the exact command for you to run. No tool, chat command or model decision can change a limit.
