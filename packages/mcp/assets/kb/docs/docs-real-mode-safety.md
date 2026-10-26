---
id: docs-real-mode-safety
title: Real mode (LIVE TRADE FIRE signals) › Safety
kind: docs
page: real-mode
page_title: Real mode (LIVE TRADE FIRE signals)
heading: Safety
anchor: safety
url: https://dexterm.xyz/docs/real-mode#safety
tags:
  - docs
  - real-mode
  - safety
  - real
  - mode
  - live
  - trade
  - fire
  - signals
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/real-mode.md
date: 2026-10-16
---

- **Only you switch a strategy to real**, on your own terminal, with the typed phrase. A model cannot: the mode is on the list of fields only you may change, the agent's decisions have no such verb, no MCP tool arms, and a file edited by hand to `"mode": "real"` is not armed. Arming, an evidence override, disarming, caps and the kill switch are all journaled in `~/.dexterm/autotrade/real/journal.jsonl`.
- **The limits live outside the model** (all of them (https://dexterm.xyz/docs/going-real#your-limits)). A buy is cut to the per-trade, position, exposure and price-impact limits. A buy over the daily SOL, buys per day, per coin or open positions limit is refused (open positions means every real holding on this machine, whichever run opened it). So is a buy after a loss stop, the drawdown breaker or a loss streak, or while your executor is silent. Sells are never blocked by a limit unless you set the optional sell rate, so an exit always goes out.
- **The real-mode kill switch**: `dexterm autotrade signal kill` stops every trade-fire signal at once, sells included. It never closes a position: it prints the open ones, and a running real run halts at its next tick and sends one `halted` that lists them for your executor. `dexterm autotrade signal unkill` (typed confirmation) lifts it. The panic switch (`dexterm wallet panic`) halts real runs too: no new entries, exits keep going out.
- **Chat approvals stay paper.** A one-tap approval never authorises a real signal: a strategy that waits for a tap (`entry.decide: "agent+approve"`, or `dexterm telegram approvals on`) does not start in real mode. Your executor is the last gate.
- The prompt firewall, the strategy clamp and the session caps apply exactly as on paper.
