---
id: docs-spectator-the-brain-view-and-the-pnl-chip
title: Spectator view (watch the agent cook) › Follow over MCP in the running terminal › The brain view and the PnL chip
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: The brain view and the PnL chip
anchor: the-brain-view-and-the-pnl-chip
url: https://dexterm.xyz/docs/spectator#the-brain-view-and-the-pnl-chip
tags:
  - docs
  - spectator
  - brain
  - view
  - pnl
  - chip
  - follow
  - over
  - mcp
  - running
  - terminal
  - watch
  - agent
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/spectator.md
date: 2026-10-16
---

While the agent is active (it made a call in the last 3 minutes, or it holds a PAPER ticket or position), the **ANALYST panel on the token screen becomes the agent's BRAIN VIEW** instead of the "press a for a dossier" help. Top to bottom:

- **REASONING.** The agent's thoughts (from `--spectate-thoughts`) typing in, newest at the bottom, each with its clock time and the phase it was in (`SCANNING`, `VETTING`, `SIZING`, ...). Older lines dim, and long lines are clipped. With no thoughts feed, the header says `dexterm narration · no thoughts feed` and the lines are dexterm's own narration of each call. Lines a demo or stand-in feed marks as scripted (`"demo": true`) carry the coral `claude lines: demo text` tag.
- **VETTING $COIN.** The checklist for the coin on screen: momentum, liquidity against the $10K floor, tape buys/sells and wallet count, top-10 concentration, mint/freeze authority, LP lock, dev history, LARP flags, the rug heuristic and the verdict. Each box shows the number the app computed and `pass`, `warn`, `fail` or `pending` (pending = that number is not in yet). `◆` marks the checks the agent itself ran.
- **DATA.** Market cap, price, liquidity, 5m and 1h moves, buy/sell flow and holders, with a candle trace. A `B` or `S` cell on the trace marks the candle of each fill of the coin in your ledgers (the chart markers (https://dexterm.xyz/docs/configuration#chart-markers)). These are the numbers already on screen; there is no extra fetch.
- **PLAN / POSITION** (while a PAPER ticket or position is open): entry, size, the take-profit and stop the agent *said* (labelled `agent's plan`, or `no stop`), mark PnL in % and paper $, peak, drawdown from the peak, time held, and what it is waiting for. A desk refusal is stamped here.
- **DECISIONS.** The session log (`rejected DECOY · verdict AVOID`, `entered`, `sold`, `desk refused`) and a scoreboard: `PAPER simulated · vetted · entries · closed · realized SOL`.

The normal analyst panel returns when the agent is killed, goes quiet, or before its first call, and also while you type into the analyst. Smaller panels drop blocks in order: the decision log first, then the data strip, then the checklist folds into two columns. The plan and the reasoning stay.

**The PnL chip.** While the agent holds a PAPER position, a chip shows it: `PAPER $COIN │ ▲ +24.0% +$2.40 │ peak +31.0% │ $0.0100 → $0.0124 │ held 1m04s │ dd −5.3% │ TP +40%`. It is on every terminal screen (screener, new pairs, watchlist, token screen, analyst) and on the chart popup (https://dexterm.xyz/docs/popup-chart#what-it-shows). On a terminal with 24 rows or more it sits in the dock's top row. On a shorter terminal there is no dock, and the chip sits on the band under the header instead. It updates on every mark tick and flashes on a new peak (a `★` under calm mode and `NO_COLOR`). Fields drop from the right on narrower terminals. The held coin stays in the fast price lane, so the chip keeps marking after the coin scrolls off the screener. In AI scan mode (https://dexterm.xyz/docs/scan#the-read) the same chip shows your own open paper or live position. The chip only shows in these two auto modes. The other popups (token, bubble map, feeds) do not carry it.

Both are display only. They have no input and cannot arm, size, sign, confirm or raise a cap. The agent's text is scrubbed and clipped, and addresses are shortened.
