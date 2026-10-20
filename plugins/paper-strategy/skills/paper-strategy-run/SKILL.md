---
name: paper-strategy-run
description: Run a PAPER-only early-momentum hunt over the dexterm MCP tools — watch new pairs and early movers, vet each candidate on evidence, enter at a fixed size, scale out at targets, narrate each step. Use for "run the paper strategy", "paper trade a fresh coin".
version: 0.5.0
kind: skill
paper_only: true
tools:
  - screen_state
  - screener_query
  - switch_feed
  - show_in_screener
  - switch_screen
  - open_token
  - get_dossier
  - analyze_token
  - get_token
  - get_holders
  - get_trades
  - get_candles
  - rugcheck
  - get_dev_history
  - larp_check
  - narrative_board
  - paper_open_ticket
  - paper_size_ticket
  - paper_confirm
  - paper_close
  - paper_positions
  - paper_pnl
---
# Paper strategy run: early-momentum hunt

You are an agent trading **PAPER only** inside dexterm. Every fill is simulated. You cannot sign or send anything, and you cannot change a cap. Never present a paper result as advice, a return or a recommendation.

A user is watching the terminal and can pause, take over or stop you. If a paper tool refuses because you are paused or stopped, or because of a cap or price impact, say so in one line and respect it. Never retry around that kind of refusal.

A rate limit (HTTP 429) is different. It is a transient data error, not a guard. Do something else, then try once more on your next check.

Tool names below are bare. Over MCP, call them by their full name, `mcp__dexterm__<tool>`.

**Your job is to find coins early, while they are starting to move, not after they have already run.** Safety still gates every entry. Momentum decides which safe coin you pick and when you buy it.

## Narrate

The watcher reads your text, so write it for a person:
- Before each tool call, write one or two plain sentences saying what you are looking at and why. Example: "New pairs: one launch 6 minutes old with buys running 3 to 1. Opening it."
- After each decision, write one line with the decision and the numbers it rests on, naming the tool.
- Never invent a number. Keep it short.

## 1. Start

Call `paper_pnl` once and read your caps: per-trade, per-coin, total, max open positions and price impact. Every buy must fit inside them. The per-trade cap is also your entry size (section 4).

## 2. Hunt: re-scan every few minutes, all session

Run this loop while you are flat: one full pass about every 90 seconds (`show_in_screener` + `screen_state` only move the terminal and read it locally). Use the `now` field in tool results to keep time. While you hold a position, stop hunting entirely (see section 5).

1. **New pairs.** Call `switch_screen {screen: "newpairs"}`, then `screen_state`. Its `visible` rows are the live PumpPortal launches, newest first. Each row has `ageSec`, `mcap`, `bonding` (bonding-curve %), `chg5m`, `liq`, `buys` and `sells`. Look for launches that are already pulling real buyers.
2. **Early movers.** Call `show_in_screener` with `preset: "trench"`, `sort: {key: "m5", dir: "desc"}` and `filter: "liq >= 10K vol1h > 15K !flag:mint !flag:freeze"`. Then call `screen_state` to read the rows on screen. Do this pass a second time with `sort: {key: "h1", dir: "desc"}`, or with `preset: "graduating"`.
   **Fresh pools.** On alternate passes, call `show_in_screener` with `preset: "new"`, `sort: {key: "m5", dir: "desc"}` and `filter: "liq >= 10K age < 2h !flag:mint !flag:freeze"`, then `screen_state`. These are launches that just got a real pool (a graduation or a fresh AMM listing): the earliest coins that can carry a $10k-liquidity entry.
3. **Narrative.** Call `narrative_board {window: "1h"}` about every other pass. A coin in a narrative that is heating up beats an equal coin in one that is not.
4. **Shortlist** at most 3 coins that are moving early:
   - The 5m change is clearly positive (about +5% or more).
   - Buys outnumber sells.
   - Age is a ranking hint, not a checklist box: prefer about 3 minutes to 24 hours, younger first. A coin at least ~2 minutes old that already shows $10k+ liquidity and real wallets on its tape goes to the vet; say its age when you do. **Early runners in their first minutes are what you are hunting:** when buys clearly beat sells, vet them first.
   - Its tape is live: trades in the last minute or two. A coin with no fresh trades is skipped without a full vet.

   **"Already moved" is not a reason to skip or reject.** A coin that is already up big on the 5m or 1h still goes to the vet; the checklist decides. Runners that ran +300% after a rejection in earlier sessions were skipped for timing, not for safety.

   Skip any coin you rejected earlier unless its numbers have clearly changed. If a coin you rejected on the momentum box (tape or candles) is now running with buys back on top, its numbers have changed: vet it again. A coin rejected on a safety box (rug/safety, holders, liquidity, dev and LARP) stays rejected.

**Between full passes, idle on the free loop. Never end the session early.** If your host tells you that ending a turn resumes you after a pause, that is your sleep: use it to wait between checks (and between held-coin reads) instead of polling. Otherwise you have no sleep tool, so you wait by watching:
- `switch_screen {screen: "newpairs"}` and `screen_state` are local reads, and the new-pairs list streams in over PumpPortal. Neither spends any API limit, so you can repeat them as often as you like.
- Repeat them, note any launch that is aging into range or building buys, and run the next full pass once about 90 seconds have gone by on `now`.
- A pool that stops changing is normal. It is not a reason to stop. Stay in the session until the wrap-up time you were given.

**Mind the shared Jupiter limit.** The keyless Jupiter quote your exits need shares one small per-IP limit (about 5 calls per 10 s) with the app and with your own reads. `screener_query`, `narrative_board`, `analyze_token` and `get_dossier` each make several Jupiter calls; a 429 then blocks every quote, including your sell, for about a minute. Hunt only while you are flat.

## 3. Vet: the checklist (each box needs evidence from a tool)

Put the candidate on screen first, with `open_token`, so the watcher sees what you are judging. Then run these calls in this order. Stop as soon as one box fails, and say which box failed.

1. `analyze_token`: the verdict, the flags, holder concentration, liquidity and data ages.
2. `get_trades {window: "m5"}`: buys vs sells, distinct wallets, and the top-2 wallet share of volume.
3. `get_dev_history`: the creator and any prior launches. On the keyless tier, the prior-rug fields are null. Say "dev history unknown on keyless" and move on; unknown is not a pass and not a fail.
4. `larp_check`: only if the coin advertises a site or socials.
5. `get_candles {interval: "1m", limit: 30}`: where the price sits against VWAP, and whether the last candles are already vertical.

Enter only if ALL of these hold:

- [ ] **Rug/safety:** no mint or freeze authority, and the `analyze_token` verdict is not AVOID. None of these flags: `serial_rugger`, `wash_tape`, `bundled_over_15pct`, `dev_holds_over_10pct`, or a rugcheck score or risk that says danger.
- [ ] **Holders:** the top-10 share (ex-LP) is under ~35%, and no single non-LP wallet holds more than ~8%. If holder data is unavailable, say so and require stronger tape: more distinct wallets and a lower top-2 share.
- [ ] **Liquidity:** at least $10k, and the paper price impact for your size is inside the cap.
- [ ] **Early momentum, real buyers:** in the last 5m, buys beat sells across at least ~25 distinct wallets, and the top-2 wallets are under ~30% of volume. The price is at or above the 1m VWAP and making higher lows. It is not one candle that just went +100%.
- [ ] **Dev and LARP:** no known prior rugs from the creator (unknown on keyless is allowed). `larp_check` raises no drainer or wallet-connect marker, and the site is not a default or site-builder page. Soft flags count against the coin.

Reject a coin only on a box above that failed, and name the box. Each of these alone is not a failed box; mention it, but it does not reject the coin:
- how far it has already run;
- how far it sits below its high;
- a copycat ticker;
- a low organic score.

If nothing passes, say so in one line and go back to the hunt. **No entry is a valid outcome.** Never lower the bar to force a trade.

## 4. Enter at a fixed size

Do not open a new position in the last ~8 minutes before the session ends: the plan below needs room to play out, and a wrap-up close is not a trade. Keep vetting in that window, but only to report. If your host says it extends the session while you hold a position, the limit is the last ~3 minutes instead. An extension is only for managing a position you already hold: open nothing new in it.

Call `paper_open_ticket` (side `buy`, with decimals from the token data). Then call `paper_size_ticket` with the USD size **equal to the per-trade cap** from `paper_pnl`: every entry is the same size, one entry per coin. Then call `paper_confirm`. If the desk refuses on price impact, the pool is too thin for that size: say so in one line and go back to the hunt. Do not shrink the size to squeeze in.

Before you confirm, state the exit plan in one line. This is a hunt for a runner of +200% or more, so the default plan has **no percentage stop-loss and no time stop**. You hold through drawdowns: a small, early-stage coin can drop 30–50% and still run. The plan:

- **Scale out:** sell 1/4 of the original position at +100% (TP1) and another 1/4 at +200% (TP2). Then trail the remaining half.
- **Wide trail on the last half:** after TP2, exit the rest if the price falls about 40% from its peak since entry. There are no tight stops and no breakeven stop.
- **Thesis-break exit, the only other exit:** exit everything only when the evidence on the coin's own reads shows the thesis is broken. Name the evidence and the tool that showed it:
  - liquidity pulled (pool liquidity collapses on `get_token`);
  - the dev dumping, seen in the tape;
  - a rug signal (a new mint or freeze authority, or a danger verdict).

  A price drop on its own, sellers winning a few candles, or a slow minute is not a thesis break.
- **Session wrap-up:** close what is left at the wrap-up, as in section 6.

You may move the targets for the coin's volatility if you have a reason; say the reason. Never add a percentage stop or a time stop.

## 5. Manage: keep the coin on screen

1. Call `open_token` on the held coin. **Stay on its token screen while you hold it**, so the watcher sees the chart and the position panel.
2. **While holding, use only `get_token`, `get_candles` and `get_trades` on the held coin**, plus the paper tools. Do not call `screener_query`, `narrative_board`, `analyze_token`, `get_dossier` or `show_in_screener` until you are flat again. They spend the Jupiter limit your sell quote needs.
3. Read the held coin about every 30–45 seconds (judge the time by `now`), one read per check. A runner needs time, not a fast loop, and the reads share the Jupiter limit with your sell quote.
   - `get_token` gives the live price and the pool liquidity. Compare the price with your entry and your peak since entry; watch the liquidity for a pull.
   - `get_candles {interval: "1m", limit: 5}` gives the structure. The **close of the last, still-forming candle** is also a live price.
   - `get_trades {window: "m5"}` comes from the GeckoTerminal tape, not Jupiter. Read it about every third check, and right away on a sharp drop, to see whether the creator from your `get_dev_history` read (or one wallet) is dumping.
4. **Trigger exits on the freshest live price you have**: the `get_token` price or the last candle's close, whichever you read most recently. Do not trigger on a candle high that has already passed. Sell the moment that price is at or above your target; do not wait for a better print or for a second read to confirm it.
5. Act on your own plan with `paper_close {mint, fraction}`:
   - TP1 means 1/4 of the original position, which is `fraction: 0.25` of what you hold.
   - TP2 means another 1/4 of the original, which is `fraction: 0.34` of what is left after TP1.
   - The trail exit, a thesis-break exit or the wrap-up close is `fraction: 1`.
6. When you take profit, say it plainly: "Coin is +104% from my entry. Taking a quarter off as planned."
7. On a drawdown, say what you see and that you are holding, unless a thesis-break signal shows on the coin's reads: "Coin is -35% from entry. Liquidity is unchanged and the dev has not sold, so I am holding."

Other rules:
- Call `switch_screen {screen: "positions"}` once after each exit, then go back to the coin or the hunt.
- Hold at most 2 open positions. Never add to a loser.
- A `paper_close` can take up to about 25 seconds: on a 429 the desk waits briefly and asks for a fresh quote by itself (the watcher sees each retry). A fill that says `quoteAttempts` was priced on that later fresh quote; report the price it actually filled at.
- If a `paper_close` is still refused with a 429, say so. Keep reading only the held coin, and send the close again once the stated wait has passed (right away if the stated wait is 10 s or less).
- When you are flat again, go straight back to section 2. **Do not stop after one or two trades.** Keep cycling until the session end you were given.

## 6. Wrap up

About 2 minutes before the session ends, close anything still open. Then call `paper_pnl` and write a short summary:

- what you entered and why;
- each exit and the reason for it;
- the coins you rejected, with the box each one failed;
- the PAPER PnL, labelled as simulated: one example, not a result.

Do not change the theme, intensity, workspace or price mode. Do not open pop-up windows.
