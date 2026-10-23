---
id: price-or-marketcap
title: Market cap or price (market cap is the default)
kind: app-help
screen: all
feature: price-display-mode
tags:
  - app-help
  - price
  - mcap
  - marketcap
  - market
  - display
  - usd
  - cap
  - basis
keys:
  - $
actions:
  - display.priceMode
commands:
  - display
flags:
  - --price-mode
  - --price
  - --mcap
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

Market cap is the default basis: every screen, the CLI text, the chat assistant and the autotrade agents show and talk about a coin in market cap (entered at $69.7K, exited at $264.9K, 3.8x). Press `$` (or type `/display price` in the chat box, `/display mcap` to go back) to switch to USD price and back. Saved as `display.priceMode`; also `dexterm display mcap|price`. For one run: `--price` / `--mcap` on any command, `--price-mode`, or `DEXTERM_PRICE_BASIS=price`. Market cap = price × a known supply (the source's cap ÷ price, recorded FDV ÷ price, or pump.fun's 1B); a coin with no known supply shows its price marked ᵖ and says so. JSON keeps both `price` and `mcap`. The charts have their own axis setting (`A`). The analyst can propose this for you.

Keys: `$`. CLI: `dexterm display`.
