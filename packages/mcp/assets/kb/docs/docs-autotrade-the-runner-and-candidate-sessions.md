---
id: docs-autotrade-the-runner-and-candidate-sessions
title: Autotrade (paper) › The runner and candidate sessions
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: The runner and candidate sessions
anchor: the-runner-and-candidate-sessions
url: https://dexterm.xyz/docs/autotrade#the-runner-and-candidate-sessions
tags:
  - docs
  - autotrade
  - runner
  - candidate
  - sessions
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
dexterm autotrade run my-swing --paper                                  # live data, your own Claude login
dexterm autotrade run my-swing --paper --replay tape.json               # a recorded tape, paced
dexterm autotrade run my-swing --paper --stub --replay tape.json        # a scripted agent: no Claude usage
```

`dexterm autotrade run` works one strategy on paper, headless, and only one runner runs per machine. It screens the same live data as the app with the app's free sources and request limits: the screener's coins every 10 seconds, and the coins it is working (candidates and positions) every 5 seconds, 30 coins per DexScreener call, under a daily call ceiling. `--replay FILE` paces a tape saved with `dexterm autotrade extract` instead; `--max-minutes N` stops after N minutes; Ctrl+C stops it cleanly.

**It talks in market cap.** The run's lines (`BUY ABC [swing]: $25.00 at $69.7K mcap`), the candidate's DOSSIER, the ENGINE notes and the EVENTs your agent reads give levels as market caps by default (with the price beside them in the DOSSIER), and your agent is told to say levels the same way. `--price` (or `display.priceMode: "price"`) switches the wording to prices; the trades are the same either way, because the engine only reads prices. The run file's fills keep `price` and add `mcap`.

**A candidate gets one session.** A coin that passes your entry rules, and that your strategy would still allow an entry for (a free slot, cash, no halt), becomes a candidate and gets one session on your own `claude` login:

- The first message is the full picture: the market now and its recent history, holders and concentration (the top-10 share the strategy's top-10 gate reads, which is Jupiter's, next to the top-10 of the largest accounts from your RPC with pools, bonding curves, launch vaults, locks and burns left out, each named with its source; when the two disagree the message says so), security (authorities and the RugCheck read), candles, recent trades, the coin's creator, and which of these are unavailable and why, plus your bounds (the exit profiles, the largest size your strategy allows, the paper book, open positions).
- After that, only what changed, with each change in percent: every 15 seconds (`agent.deltaEverySec`), or at once on a fast move (8% in price or a 15% drop in liquidity). Updates that pile up while the agent is thinking go as one message.
- Your agent answers every message with one typed decision: `enter`, `wait` or `skip` before a position; `hold`, `exit`, `tighten` or `reprofile` once it holds one. Anything outside that closed form (an unknown field, a size out of range) does nothing.
- An `enter` is clamped by your strategy, and every cut is named in the run file; the order fills on the paper book after the strategy's latency, and is refused if the price ran past the slippage tolerance in between. Fills and refusals reach the agent as notes on its next message.
- With a position, the exits in your profile run on their own; the agent hears about them as events and can only lower the risk (exit, trim, tighten) or move along the profile's allowed edges. When the position closes, its session ends.
- A reply that arrives after its candidate was dropped (it stopped matching, the agent skipped, the session ran out) is written down and never executed.
- With `agent.respawnOnWake` in the strategy, a judgement call on a position whose session has already ended opens a short position session that answers once.
