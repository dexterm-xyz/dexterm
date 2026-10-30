---
id: docs-paper-trading
title: Paper trading and the safety model
kind: docs
page: paper-trading
page_title: Paper trading and the safety model
url: https://dexterm.xyz/docs/paper-trading
tags:
  - docs
  - paper-trading
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

The PAPER ticket, the simulated wallet, the confirm gate, order plans on paper, PnL cards and the trade ledger. dexterm holds no key and signs nothing.

Trading in dexterm is **PAPER by default**: a simulated wallet priced from live, keyless Jupiter quotes. Nothing is signed, no key is held, no transaction is sent, and the paper code imports no wallet or signing library of any kind. Every ticket and positions frame says so in a banner that is never hidden.

dexterm has no live trading path of its own: it holds no key, has no trading wallet and builds or sends no transaction. Live trading happens in a Telegram trading bot of your choice; see Live trading (https://dexterm.xyz/docs/live-trading). Real mode is experimental; signals to your own executor; dexterm never holds a key; not financial advice (see Real mode (https://dexterm.xyz/docs/real-mode)).

PAPER positions on sample data
