---
id: docs-live-trading-what-dexterm-does-not-do
title: Live trading › What dexterm does not do
kind: docs
page: live-trading
page_title: Live trading
heading: What dexterm does not do
anchor: what-dexterm-does-not-do
url: https://dexterm.xyz/docs/live-trading#what-dexterm-does-not-do
tags:
  - docs
  - live-trading
  - dexterm
  - does
  - live
  - trading
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/live-trading.md
date: 2026-10-16
---

- It does not place an order in your trading bot for you. In this version you act in the bot yourself.
- It does not hold, import, create, decrypt or ask for a private key or seed phrase. Anything that asks you for one is not dexterm.
- It does not sign or send a transaction. `dexterm wallet link` only proves which wallet is yours with a signed **message** in Phantom; dexterm keeps the public key to show your address. It never asks Phantom to sign a transaction.
- It does not know what your trading bot did. Positions, fills and P/L in dexterm are paper.
