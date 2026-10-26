---
id: docs-real-mode-receipts-what-your-executor-did
title: Real mode (LIVE TRADE FIRE signals) › Receipts: what your executor did
kind: docs
page: real-mode
page_title: Real mode (LIVE TRADE FIRE signals)
heading: Receipts: what your executor did
anchor: receipts-what-your-executor-did
url: https://dexterm.xyz/docs/real-mode#receipts-what-your-executor-did
tags:
  - docs
  - real-mode
  - receipts
  - executor
  - did
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

dexterm cannot see your executor's wallet trades, so a real position stays **unconfirmed** until a receipt arrives. A receipt is data only: it never makes dexterm buy, sell or change anything.

```
dexterm autotrade receipt 42 executed --size-sol 0.049 --price 0.00121 --tokens 40500 --tx <signature>
dexterm autotrade receipt 43 rejected --reason "slippage too high"
dexterm autotrade receipt list
```

Your executor can also append one line per signal to `~/.dexterm/autotrade/real/receipts.jsonl`: `{"schema":"dexterm-trade-receipt/1","signalId":"…","nonce":42,"accountId":"main","status":"executed","at":1792000004000,"fill":{"priceUsd":0.00121,"sizeSol":0.049,"tokens":40500,"txSig":"…"},"reason":null,"executor":"my-bot"}`. A receipt for an unknown nonce, another account or a mismatched id is counted and ignored.

The exits keep firing on dexterm's own view of the market whether or not a receipt came. A receipt with a fill also says how far the real fill landed from dexterm's paper fill (paper vs real (https://dexterm.xyz/docs/going-real#paper-vs-real)). The drift between signals and receipts (unconfirmed, rejected, failed, filled size and price against the signal) shows in `receipt list`, `signal status`, `dexterm autotrade audit` and the run file (receipt rows). `dexterm autotrade signal reconcile --wallet <your PUBLIC address>` reads that address's SOL balance and token holdings (two read-only calls) and lists the coins the real book holds that the wallet does not, and back. It never takes a key.
