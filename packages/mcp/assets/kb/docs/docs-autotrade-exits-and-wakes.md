---
id: docs-autotrade-exits-and-wakes
title: Autotrade (paper) › Exits and wakes
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Exits and wakes
anchor: exits-and-wakes
url: https://dexterm.xyz/docs/autotrade#exits-and-wakes
tags:
  - docs
  - autotrade
  - exits
  - wakes
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

Exits never wait for your agent. On every tick of a coin you hold, a position monitor runs your exit profile's mechanical rules at once, in this order, and a full exit ends that tick:

1. **Rug or liquidity pull**: the pool is under the strategy's `execution.minExitLiquidityUsd`. A bag that cannot be sold is marked stuck and tried again on every tick.
2. **Thesis breaks**: liquidity down by the profile's percent from its recent high, a market-cap source split (the two sources count supplies more than 5× apart; a price move alone never counts, even when one source's figure is minutes old), or dead volume. (The dev-sell exit needs on-chain sell events, which are not recorded yet, so it does not fire.)
3. **Maximum hold** (`maxHoldMinutes`): the position's own dead-man.
4. **Hard stop**, when the profile has one.
5. **Cost recovery** (moonbag): once, at the profile's gain (+100% in moonbag), sell the slice whose proceeds pay back what the position cost, at most `maxSellFrac` of the bag (60% in moonbag). What is left is a free bag.
6. **The take-profit ladder**: several steps can fill on one jump.
7. **The bag trail** (moonbag): only after the cost came back, measured from the peak since entry (55% in moonbag).
8. **The trailing stop.**
9. **The time stop**, when its action is `exit`.
10. **Scale-in tranches** (`sizing.ladder`), each re-capped by your strategy.

**Wakes.** Only after those rules ran does the position's session hear anything, and everything from one tick goes out as one message:

```
EVENT tp_filled: TP1 filled at +62.0%; 67% of the original size left
position p1: profile swing, cost $20.00, +62.0% on the mid price, TP filled 1, 67% of the size left, liq $100K
Reply with one of: hold, exit, tighten, reprofile.
```

| event | when | your agent may answer | no answer, or no session |
|---|---|---|---|
| `tp_filled` | a take-profit step filled (when the profile asks for it) | hold, exit, tighten, reprofile | hold |
| `cost_recovered` | the cost-recovery sell filled (moonbag) | hold, exit, tighten | hold |
| `time_review` / `time_tighten` | the profile's clock ran out below its target | hold, exit, tighten | the profile's `wake.noAnswer` (swing: exit, runner: hold) |
| `drawdown` | the position fell to the profile's `wake.drawdownPct` | hold, exit, tighten | hold |
| `thesis_warning` | liquidity fell part of the way to a thesis exit | hold, exit, tighten | hold |
| `mechanical_exit` | after any mechanical exit (for information) | hold | — |
| `stuck` | a sell could not execute | hold | tried again every tick |

**What an answer can do.** Your agent can only lower the risk:

- `exit` sells everything, and `exit` with a `fraction` trims.
- `tighten` arms the trailing stop now; on a free bag it halves the bag trail (never below 10%), and nothing can loosen it again.
- `reprofile` moves only along the profile's `reprofileTo` edges, and a move to a profile that allows a bigger size needs the first take-profit filled.
- It can never add size: an `enter` or a size on a held coin is refused and written down.
- It can never stop or delay a mechanical exit: the next tick's rules run whether a reply is pending or not. A reply that lands after its position closed, or after `agent.decideWithinSec`, is written down and never executed.

**On the paper desk.** When the monitor runs as its own process, its orders go through the same paper desk (https://dexterm.xyz/docs/agents#agent-paper-trading) that agents use, so every fence there applies around your strategy's own clamp:

- A paper-only mandate you armed yourself with a keypress (`dexterm mandate draft --paper`). Its caps apply at the agent tier (a quarter of the per-trade cap), and an entry is refused without one.
- Each entry registers an exit plan with the desk, and each monitor sell is journaled as `agent.paper.exit.<rule>` (for example `agent.paper.exit.cost-recovery` or `agent.paper.exit.bag-trail`). Every fill carries a short note naming the run, the position, the profile and the exit rule.
- A cost-recovery slice is sized on at most three Jupiter quotes (one for the largest allowed slice, one to confirm the estimate, at most one correction); without a quote it waits for the next tick instead of guessing.
- A `close-only` control state lets exits run while every new buy is refused, also after the mandate has expired. `dexterm wallet panic` stops everything, exits included.

**Restarts and the dead-man.** The monitor rebuilds its positions from the paper journal and the run files. An exit that was journaled but had not filled when it stopped is never sent again; the next tick decides afresh. Paper positions it did not open are left alone. It writes `~/.dexterm/autotrade/monitor-status.json` every 10 seconds, and entries are refused when that is more than 30 seconds old. It keeps exiting while the runner is down, but it adds no scale-in tranche then.

**Today's limits.** The monitor and the desk changes are in the app, but `dexterm autotrade run` does not use them yet. Until it does, these same rules run in the same order on the engine's own paper book, the one backtests use.

Paper only: the monitor refuses a strategy in live mode, and nothing in it can arm a mandate, sign, or touch a wallet or a key.
