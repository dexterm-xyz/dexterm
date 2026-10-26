---
id: docs-real-mode-what-it-will-not-do
title: Real mode (LIVE TRADE FIRE signals) › What it will not do
kind: docs
page: real-mode
page_title: Real mode (LIVE TRADE FIRE signals)
heading: What it will not do
anchor: what-it-will-not-do
url: https://dexterm.xyz/docs/real-mode#what-it-will-not-do
tags:
  - docs
  - real-mode
  - will
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

- Hold, import or ask for a key or a seed phrase, sign, or send a transaction.
- Trade on a replay, or let a chat tap authorise a real trade.
- Promise a fill. Your executor decides, at its own price, with its own fees.
- Run more than one real strategy per machine at a time, run one inside `run --all`, or run one under the always-on service (in 0.2.0 real runs in the foreground only).
- Send any signal, sells included, while no real run is running, or close a position by itself.
