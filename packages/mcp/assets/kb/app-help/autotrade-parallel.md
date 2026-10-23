---
id: autotrade-parallel
title: Run several autotrade strategies at once on paper (dexterm autotrade run --all)
kind: app-help
screen: all
feature: autotrade-parallel
tags:
  - app-help
  - autotrade
  - parallel
  - several
  - multiple
  - strategies
  - compare
  - side
  - forward
  - test
  - bankroll
  - fleet
  - autotrade.json
commands:
  - autotrade
tools:
  - autotrade_parallel_list
  - autotrade_parallel_compare
  - autotrade_parallel_start
  - autotrade_parallel_stop
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

`dexterm autotrade run --all --paper` runs every strategy listed in ~/.dexterm/autotrade/autotrade.json at the same time on one data feed, to forward-test several ideas side by side. Each entry has an `id`, a `preset` (a shipped preset or your own strategy) or an absolute `file`, a `bankroll` in USD or SOL, optional `caps` that can only tighten it, and `enabled`. Each strategy gets its own paper book, run file, loss limits and breaker, sessions and model spend budget; a breaker or a stop on one never stops another. The screener fetches once for all of them, and the `global` limits (sessions open at once, model spend and sessions per day, one check of how busy the computer is) count across all of them. `dexterm autotrade status --all` and the runner view on the AUTOTRADE screen (`Q`) compare them: P/L, win rate with the closed count, rug exits and exposure, missed runners, spend per entry. `dexterm autotrade stop|flatten|pause|resume` act on every strategy; add `--strategy ID` to act on one, and `dexterm autotrade start ID` starts a listed one that is not running. An MCP agent can list and compare them and start or stop one listed strategy, never add one or change a size or a cap. Paper only: live is refused. Not financial advice. Full docs: https://dexterm.xyz/docs/autotrade/#several-strategies-at-once

CLI: `dexterm autotrade`.
