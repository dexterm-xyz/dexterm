---
id: docs-autotrade-strategies-and-presets
title: Autotrade (paper) › Strategies and presets
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Strategies and presets
anchor: strategies-and-presets
url: https://dexterm.xyz/docs/autotrade#strategies-and-presets
tags:
  - docs
  - autotrade
  - strategies
  - presets
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

A strategy is one JSON file (`dexterm-strategy/1`) with six parts:

- **Entry**: the screener filter grammar (https://dexterm.xyz/docs/screens), verbatim (for example `liq >= 30K vol1h > 15K !flag:mint !flag:freeze`), an age window, safety gates (no mint or freeze authority, top-10 share, dev share, a market-cap source split, a "young and already vertical" reject, and what to do when the holder source is down) and triggers (every screen match, or a 5-minute momentum push).
- **Exits**: one or more exit profiles: a take-profit ladder, a trailing stop, a time stop, an optional hard stop, thesis breaks (a liquidity drop, a market-cap source split, dead volume), a maximum hold time and, for the moonbag profile, a cost-recovery sell and a trail on the free bag that is left.
- **Sizing**: a fixed amount, a percent of the book, risk-sized against the stop, or scaled by the agent's confidence inside your bounds, with optional scale-in tranches. Every size is capped by a maximum percent and a maximum dollar amount.
- **Risk**: a per-trade loss cap, a daily loss halt, drawdown size-down and halt levels, the most positions open at once, total exposure, entries per day, a loss-streak cooldown and per-coin re-entry rules.
- **Agent** and **execution**: the session limits for the runner (https://dexterm.xyz/docs/autotrade#the-runner-and-candidate-sessions) and the fill model's fee, slippage, network fee, price-impact cap and the liquidity below which a bag cannot be sold.

The file is closed: an unknown key is refused with its path, so a strategy cannot carry a `signer`, `wallet` or `key` section. Validation also checks the rules a schema cannot (a take-profit ladder that climbs, sell fractions that add up to at most the whole position, sizing parameters that match the sizing mode, drawdown levels in order) and prints every problem with its path. Every strategy gets a content hash, so a backtest line always names the exact rules it ran.
