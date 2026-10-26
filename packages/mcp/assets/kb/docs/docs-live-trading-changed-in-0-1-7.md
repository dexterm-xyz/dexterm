---
id: docs-live-trading-changed-in-0-1-7
title: Live trading › Changed in 0.1.7
kind: docs
page: live-trading
page_title: Live trading
heading: Changed in 0.1.7
anchor: changed-in-0-1-7
url: https://dexterm.xyz/docs/live-trading#changed-in-0-1-7
tags:
  - docs
  - live-trading
  - changed
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

Earlier 0.1.7 test builds had an experimental local live signer with a dedicated trading wallet, and a LIVE trade ticket signed in Phantom. Both were removed before release, because dexterm should not hold a key. Sending a strategy's trades to an executor of your choice automatically is real mode (https://dexterm.xyz/docs/real-mode), new in 0.2.0, still with no key in dexterm.
