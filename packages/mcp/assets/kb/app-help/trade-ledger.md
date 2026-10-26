---
id: trade-ledger
title: See every trade in one ledger: win rate, profiles, exit reasons, strategy versions (dexterm ledger)
kind: app-help
screen: all
feature: trade-ledger
tags:
  - app-help
  - ledger
  - journal
  - trades
  - history
  - results
  - stats
  - win
  - rate
  - drawdown
  - profile
  - exit
  - reason
  - compare
  - export
  - csv
  - equity
  - mfe
  - mae
commands:
  - ledger
tools:
  - ledger_trades
  - ledger_positions
  - ledger_summary
  - ledger_equity
  - ledger_compare
  - candidate_dossier
  - outcomes_lookup
  - trading_status
  - telegram_status
  - backtest_requests
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

`dexterm ledger trades` lists every round trip dexterm booked, from the paper ticket, the agent paper desk and autotrade runs, newest first: strategy version, the exit profile and entry reason it was opened with (marked * when not declared with the fill), the exit reason, size and % of book, entry and exit market cap, P/L, hold and MFE/MAE. `positions` shows the open ones. `summary` gives the win rate with its 95% interval, P/L, profit factor, drawdown and rug rate by profile, exit reason, strategy, source and mode; `equity` the realized equity curve; `compare` strategy versions side by side (for strategies run in parallel); `export csv|json|parquet-lite [--out FILE]`; `card <tradeId>` a PnL card from a row. Filters: --source, --mode paper|devnet|live|real (real = a real-mode run: dexterm's model of the trades it signalled), --strategy id[@version], --profile, --exit, --mint, --run, --days, --status. Reads never write; `dexterm ledger sync` appends to ~/.dexterm/ledger/trades.jsonl (sha256-chained) and `dexterm ledger verify` names the first edited line. Agents read the same rows with the read-only ledger_* tools; `trading_status` and `telegram_status` show settings and state, never a key, address, exact balance, bot token or chat id. A backtest an agent asks for (backtest_request) only runs when you run it: `dexterm autotrade requests`. PAPER rows are simulated; filter by --mode before comparing. Not financial advice. Full docs: https://dexterm.xyz/docs/paper-trading/#the-trade-ledger

CLI: `dexterm ledger`.
