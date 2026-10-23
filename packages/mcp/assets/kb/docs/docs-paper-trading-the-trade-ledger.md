---
id: docs-paper-trading-the-trade-ledger
title: Paper trading and the safety model › The trade ledger
kind: docs
page: paper-trading
page_title: Paper trading and the safety model
heading: The trade ledger
anchor: the-trade-ledger
url: https://dexterm.xyz/docs/paper-trading#the-trade-ledger
tags:
  - docs
  - paper-trading
  - trade
  - ledger
  - paper
  - trading
  - safety
  - model
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/paper-trading.md
date: 2026-10-16
---

`dexterm ledger` puts every trade dexterm booked in one table: the paper ticket, the agent paper desk and autotrade runs. One row is one round trip: the strategy and its version, the **exit profile** and entry reason the trade was opened with, the **exit reason**, size and share of the book, entry and exit as price and **market cap**, fees, hold time, the best and worst move while held (MFE / MAE, from the fills), and whether it rugged. Every row dexterm books is PAPER.

- `dexterm ledger trades` lists them, newest first; `positions` shows what is open.
- `dexterm ledger summary` gives the win rate with its 95% interval, P/L, profit factor, max drawdown, rug rate and hold time, broken down by profile, exit reason, strategy, source and mode. `equity` draws the realized equity curve.
- `dexterm ledger compare` puts strategy versions side by side, which is how you read strategies you forward-test in parallel.
- `dexterm ledger export csv|json|parquet-lite` writes the rows out for your own spreadsheet or notebook.
- `dexterm ledger card <tradeId>` makes a PnL card (https://dexterm.xyz/docs/paper-trading#pnl-cards) from a ledger row, with market cap at entry and exit.
- Filters: `--source`, `--mode`, `--strategy id[@version]`, `--profile`, `--exit`, `--mint`, `--run`, `--account`, `--days`, `--status`. `--account ID` keeps the trades of the strategies on one paper account (https://dexterm.xyz/docs/autotrade#paper-accounts); the export has an `account` column.

**Declared, not guessed.** An agent declares its exit profile when it buys and its exit reason when it sells, as typed fields on the paper desk (or a PROFILE / EXIT line), and the ledger shows where each tag came from: declared with the fill, from an exit rule, from a tag line, declared later, or missing. Undeclared trades are counted, not filled in.

**Your file, append-only.** Reads never write. `dexterm ledger sync` appends what the sources hold to `~/.dexterm/ledger/trades.jsonl`, where every line is sha256-chained to the one before; `dexterm ledger verify` recomputes the chain and names the first edited line, and an edited file is never appended to. No network, no model, no key.

PAPER rows are simulated. A small number of trades says little, and the summary says so. Not financial advice.
