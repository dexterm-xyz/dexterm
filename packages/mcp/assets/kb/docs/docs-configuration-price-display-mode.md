---
id: docs-configuration-price-display-mode
title: Configuration and files on disk › Price display mode
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Price display mode
anchor: price-display-mode
url: https://dexterm.xyz/docs/configuration#price-display-mode
tags:
  - docs
  - configuration
  - price
  - display
  - mode
  - files
  - disk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/configuration.md
date: 2026-10-16
---

Memecoin traders think in market cap, so dexterm shows and talks about every coin in **market cap by default**: the screens, the CLI text, the chat assistant and the autotrade agents ("entered at $69.7K, exited at $264.9K, 3.8x"). USD price per token is the alternative. It is a display and wording setting only: the same data underneath, no extra requests, and nothing that trades (signer, caps, tickets, plans, the confirm gate, the autotrade engine) reads it.

- The setting is `"display": { "priceMode": "mcap" }` in `config.json` (`"price"` for USD price). `$` flips it on every screen and saves it through the journal, so `ctrl+z` undoes it; `/display mcap|price` in the chat box (also `/basis …`, `/set basis …`) does the same, and `/display` alone says which is on. `dexterm display [mcap|price]` shows or sets it from the command line. For one run: `--mcap` / `--price` on any command (`dexterm --price autotrade run …`), `--price-mode mcap|price`, or `DEXTERM_PRICE_BASIS=mcap|price`; nothing is saved. A workspace may carry `"priceMode"` and switches to it while active.
- Market cap = price × a **known** supply: the market cap a source reports at the same tick (its market cap ÷ its price), the recorded FDV ÷ price, or pump.fun's fixed 1B for a pump.fun coin (the same rule as the PnL cards (https://dexterm.xyz/docs/paper-trading)). A supply is never guessed: without one the slot shows the price and says so (`ᵖ` after the number in a table, the panel caption counts them; `supply unknown · showing price` on a spotlight or header; `price; supply unknown` in a sentence).
- Screens: the screener, watchlist and new pairs lead with **MCAP** (PRICE moves to MCAP's old column, every sort key works as before); the watchlist's entry becomes **ENTRY MC**; spotlights, the token header and the export report lead with the market cap and keep the price beside it. Position rows read **AVG MC** / **MCAP**, and STOP / TARGET, the trade tape, the ticket's price line and PAPER fill line (`@ $69.7K mcap (0.0000004 SOL)`), the trade history, the PnL chip, the brain view and the agent HUD's cards read market caps too. Profit and loss stay in USD (or SOL on the paper screen). The analyst's coin tables lead with MCAP.
- Charts have their own setting, the chart Y axis (https://dexterm.xyz/docs/configuration#chart-y-axis) (market cap by default); `$` does not change it.
- Order plans already trigger on market cap: the `O` screen and the plans popup show each level with both numbers (`entry mc ≤ $300K ($0.0₃3)`), the price taken from the plan's own supply snapshot.
- The assistants speak the same basis, read at run time: the chat assistant's instructions and its live context (cap at entry, cap now, cap targets and stops, x-multiples), the autotrade candidate and position agents (their DOSSIER, ENGINE notes and EVENTs), and the MCP tools (https://dexterm.xyz/docs/analyst#mcp-tools): every price field has a market-cap twin (`mcap`, `entryMcap`, `lastMcap`, …; `null` when the supply is unknown) and the tool descriptions tell an external agent to talk in market cap unless the user chose price.
- JSON keeps **both** numbers always: a price field is never removed or renamed, its cap twin sits beside it (the autotrade ledger's fills carry `price` and `mcap`, `avgPrice` and `avgMcap`). Only the human-facing text switches.
- `config.json` moved to **v5** for this: a file saved with the old default (`priceMode: "price"`, written by every first save) is moved to market cap on load, with a backup kept as `config.json.bak-v4`; a `price` you chose yourself (`$`, `dexterm display price`, an approved proposal, all in the journal) is kept.
