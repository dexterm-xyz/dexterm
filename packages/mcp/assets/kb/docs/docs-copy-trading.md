---
id: docs-copy-trading
title: Copy trading (staged, personal, paper by default)
kind: docs
page: copy-trading
page_title: Copy trading (staged, personal, paper by default)
url: https://dexterm.xyz/docs/copy-trading
tags:
  - docs
  - copy-trading
  - copy
  - trading
  - staged
  - personal
  - paper
  - default
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/copy-trading.md
date: 2026-10-16
---

Follow a wallet and see its decoded swaps and PnL; turn its buys into a mirror PROPOSAL with one key; or let a capped, keypress-armed auto-mirror propose and arm them for you. Your wallet, your caps, your keys.

Copy trading in dexterm is a **personal tool for your own wallet**. You pick the wallets, you set the caps, and the paper wallet simulates every mirror. dexterm never holds funds or keys, never signs, never copies for anyone else, never offers pooled or hosted copying, never publishes a leader list, and takes no fee on a mirrored trade. The whole feature is labelled **in progress**: it is on main and tested on fixtures and the wallet-intel spike recordings, and every mirror, the auto tier included, fills through the paper executor. No mirror moves real funds.

It is built in three stages, each behind the previous one's gate.
