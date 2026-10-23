---
id: docs-autotrade-one-strategy-or-all-of-them
title: Autotrade (paper) › Several strategies at once › One strategy, or all of them
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: One strategy, or all of them
anchor: one-strategy-or-all-of-them
url: https://dexterm.xyz/docs/autotrade#one-strategy-or-all-of-them
tags:
  - docs
  - autotrade
  - strategy
  - all
  - them
  - several
  - strategies
  - once
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

- **All of them:** `dexterm autotrade stop`, `dexterm autotrade flatten`, `dexterm autotrade pause` and `resume`, the Q screen's `!`, `f` and `p`, `dexterm wallet panic`, and Ctrl+C.
- **One of them:** `dexterm autotrade stop --strategy ID` (no new entries, its sessions close, its exits run until it holds nothing; final for that run), `flatten --strategy ID`, `pause --strategy ID` and `resume --strategy ID`, and `dexterm autotrade start ID` for a listed strategy that is not running. The other strategies keep going.

An agent you connect over MCP can read the list and the comparison, accounts included (`autotrade_parallel_list`, `autotrade_parallel_compare`), and can start, stop or pause one strategy that you listed (`autotrade_parallel_start`, `autotrade_parallel_stop`). It cannot add a strategy or an account, move a strategy to another account, change a size or a cap, or start anything that is not on paper.

Paper only: `--live` and `"mode": "live"` are refused. dexterm holds no key; live trading happens in a Telegram trading bot of your choice (see Live trading (https://dexterm.xyz/docs/live-trading)). Simulated fills, not financial advice.
