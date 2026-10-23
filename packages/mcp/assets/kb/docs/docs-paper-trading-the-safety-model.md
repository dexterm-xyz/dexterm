---
id: docs-paper-trading-the-safety-model
title: Paper trading and the safety model › The safety model
kind: docs
page: paper-trading
page_title: Paper trading and the safety model
heading: The safety model
anchor: the-safety-model
url: https://dexterm.xyz/docs/paper-trading#the-safety-model
tags:
  - docs
  - paper-trading
  - safety
  - model
  - paper
  - trading
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/paper-trading.md
date: 2026-10-16
---

These are the invariants; hold us to them:

1. **No custody.** dexterm holds no private key, has no trading wallet and has no signing code. The Phantom link stores only your public key, from a signed message.
2. **Nothing is sent.** dexterm builds no transaction and sends none. Every ticket, plan, autotrade run and agent fill is paper.
3. **Keypress gate on by default.** Models and voice create proposals; arming a plan or confirming a ticket needs a physical keypress. Opting out, if ever offered, needs an explicit "this is less safe" confirmation and is local, logged and reversible.
4. **The AI has no trading interface.** No build, sign or send tool exists for the model. Its write-shaped tools are paper only: `open_ticket` opens a PAPER ticket, and (only if you start `--agent-paper` on a mandate you armed) an agent you connected can use the `paper_*` tools to book the **simulated** ledger inside that mandate. A registry test enumerates every MCP tool and fails if any could reach a signing or sending path.

> warn: paper results are not predictive. Paper fills take the quote at its word; a real fill pays real slippage, priority fees and failed transactions, and most memecoins go to zero. Nothing here is financial advice.
