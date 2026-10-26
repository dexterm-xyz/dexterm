---
id: docs-real-mode-the-signal
title: Real mode (LIVE TRADE FIRE signals) › The signal
kind: docs
page: real-mode
page_title: Real mode (LIVE TRADE FIRE signals)
heading: The signal
anchor: the-signal
url: https://dexterm.xyz/docs/real-mode#the-signal
tags:
  - docs
  - real-mode
  - signal
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

One line of JSON, the same bytes on every channel:

```json
{"schema":"dexterm-trade-fire/1","type":"trade","id":"9f2c…(32 hex)","nonce":42,"issuedAt":1792000000000,"expiresAt":1792000060000,"ttlSec":60,"runId":"…","accountId":"main","strategy":{"id":"my-strategy","version":"1.0.1","hash":"…"},"paper":false,"side":"buy","mint":"…","symbol":"PEPE","sizeSol":0.05,"sizeUsd":10,"pctOfBook":2,"sellFraction":null,"price":{"usd":0.0012,"mcap":1200000,"liqUsd":48000,"solUsd":200},"exitReason":null,"slippageBps":300,"maxImpactPct":3,"positionId":"…"}
```

- `type`: `trade`, `halted` (the run ended or stopped: `outstanding` lists the nonces it had sent that had not expired, `open` the coins dexterm still counts as held for the account) or `test`.
- `side` `buy` or `sell`. A buy states `sizeSol` (what to spend) and `pctOfBook`. A sell states `sellFraction`, the share of the position to sell (apply it to what you really hold), and `exitReason` (the exit rule that fired: `hard-stop`, `trail`, `tp-1`, `agent-exit`, `flatten` and so on); its `sizeSol` is dexterm's modelled proceeds and can be 0 for a coin that rugged.
- `nonce` only ever grows, across runs and restarts. `id` is the idempotency key (a hash of the account, the run and the nonce). `paper` is always `false`.
- **Firewall**: the only token-made text in a signal is the symbol, reduced to `A-Z a-z 0-9 . _ $ -` (16 characters). No name, no description, no link, no agent text, no path, no key.

**What a well-behaved executor does with each signal:**

1. Check the HMAC (when you set a secret): `x-dexterm-signature: t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of `<t>.<body>` with your secret. Refuse a timestamp more than 5 minutes off.
2. Ignore it after `expiresAt`. A late signal is never acted on.
3. Act once per `nonce` (delivery is at least once: a repeat is normal) and ignore a nonce lower than one already acted on.
4. Act only on the `accountId` it was set up for.

`SignalReceiver` in `@dexterm/autotrade` does these four checks, if your executor is written in Node.
