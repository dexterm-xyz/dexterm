---
id: docs-real-mode-what-it-is
title: Real mode (LIVE TRADE FIRE signals) › What it is
kind: docs
page: real-mode
page_title: Real mode (LIVE TRADE FIRE signals)
heading: What it is
anchor: what-it-is
url: https://dexterm.xyz/docs/real-mode#what-it-is
tags:
  - docs
  - real-mode
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

> **0.2.0, experimental.** Real mode can lead to real trades in a wallet you fund. dexterm never holds a key, never signs and never sends a transaction: your executor does, by its own rules. Not financial advice.

Every strategy runs on **paper** by default. In **real** mode the same strategy runs the same way: the same entry rules, the same clamp on every size, the same exits, the same monitor and the same run file as paper. The difference: every buy and sell it fills on its own model of the market also goes out, first, as a **LIVE TRADE FIRE** signal (`dexterm-trade-fire/1`) to the executor you chose.

- **Your executor** is a Telegram trading bot you trust, or any script of yours. It holds its own wallet and decides whether to act on a signal.
- **dexterm** holds no key, signs nothing and builds no transaction. It sends the signal, keeps it in an outbox until it is delivered, and records what your executor says it did.
- **A bot cannot read another bot's messages**, so the signal also goes over a channel your executor can read: a local webhook, a command, a stream file or MCP. The Telegram message to your own chat is the copy for you.
