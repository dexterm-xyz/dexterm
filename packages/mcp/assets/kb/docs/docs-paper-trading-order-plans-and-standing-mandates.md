---
id: docs-paper-trading-order-plans-and-standing-mandates
title: Paper trading and the safety model › Order plans and standing mandates
kind: docs
page: paper-trading
page_title: Paper trading and the safety model
heading: Order plans and standing mandates
anchor: order-plans-and-standing-mandates
url: https://dexterm.xyz/docs/paper-trading#order-plans-and-standing-mandates
tags:
  - docs
  - paper-trading
  - order
  - plans
  - standing
  - mandates
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

Labelled **in progress**: the engine, the typed and spoken proposal paths, the `O` screen, the popup and the audit journal are on main, and every plan fills on **paper**. There is no live fire path: plans never sign or send anything.

An **order plan** is "buy this coin if it dips to 300k market cap, sell half at 600k, keep the rest as a moon bag", written down once: one entry trigger (market cap or price, below or above, or immediate), a ladder of take-profit tranches (each an above-trigger with a fraction; whatever the fractions leave is the moon bag), an optional stop (a below-trigger, below the entry), slippage and impact ceilings and an expiry (4 h by default, 7 days at most). `dexterm plan propose --mint M --size 20 --entry mc-below:300k --tp mc-above:600k:50% --stop mc-below:150k` writes one; so does saying it to Jarvis (https://dexterm.xyz/docs/voice) or an agent's `propose_order_plan` tool. All three produce the same thing: an **inert proposal** with a SHA-256 hash of its material fields and a plain-language read-back. A proposal fires nothing.

A **standing mandate** is the budget a set of plans may spend: a total, a per-trade cap, a per-coin cap, a daily-loss cap, the highest confirmation tier it accepts and a time-to-live. Every cap is clamped to a hard ceiling ($2000 total, $500 per trade, $1000 per coin, $2000 daily loss, 24 h) and nothing is ever coerced upward: there is no "raise cap" anywhere; a different cap is a new draft that needs a new arming gesture. `dexterm mandate draft --total 100 --per-trade 20 --ttl-hours 4` writes one; `--max-open N` and `--max-impact PCT` set the open-position and price-impact limits (clamped the same way).
