---
id: docs-autotrade-the-run-file-and-the-heartbeat
title: Autotrade (paper) › The runner and candidate sessions › The run file and the heartbeat
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: The run file and the heartbeat
anchor: the-run-file-and-the-heartbeat
url: https://dexterm.xyz/docs/autotrade#the-run-file-and-the-heartbeat
tags:
  - docs
  - autotrade
  - run
  - file
  - heartbeat
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

Every step goes to `~/.dexterm/autotrade/runs/<run>.jsonl`, written as it happens: each message sent, each raw reply and parsed decision, the clamp with its cuts, fills, events, refusals, session costs and the usage readings. Each line carries the hash of the one before it, so an edited, missing or reordered line shows. A summary sits next to it, and `~/.dexterm/autotrade/runner-status.json` (candidates, sessions, positions, spend and the last steps) is rewritten every 10 seconds as the runner's heartbeat. The coins it is working are also handed to the recorder's 5-second sampling (`dexterm record run --focus-ticks`).

**Today's limits.** Orders fill on the runner's own paper book with the backtest's fill model (price impact on the pool, fee, slippage). Filling through the paper desk and the exit monitor as its own process are still to come. To stop the runner, see Stopping it (https://dexterm.xyz/docs/autotrade#stopping-it).

Paper only: `--live` is refused, a strategy in live mode is refused, and nothing in the runner can arm a mandate, sign, or touch a wallet or a key.
