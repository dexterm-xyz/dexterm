---
id: docs-ollama-restriction-profiles
title: Use a local model with Ollama › Restriction profiles
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Restriction profiles
anchor: restriction-profiles
url: https://dexterm.xyz/docs/ollama#restriction-profiles
tags:
  - docs
  - ollama
  - restriction
  - profiles
  - use
  - local
  - model
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/ollama.md
date: 2026-10-16
---

| profile | the local engine may |
|---|---|
| `observe` | analyse only: the read tools, no UI actions, no proposals, no orders |
| `propose` | everything the analyst does on Claude: the read tools, the UI actions (open a coin, the screener, the watchlist, a feed, and open a PAPER ticket that you confirm), and strategy proposals you apply with a key. No orders. |
| `paper` | `propose`, plus paper orders: the AUTOTRADE runner's paper sessions, agent paper trading (https://dexterm.xyz/docs/agents) inside a mandate you armed, starting or stopping one of your parallel strategies (https://dexterm.xyz/docs/autotrade#several-strategies-at-once), paper journal tags and backtest requests |
| `full` | everything the Claude path may do, inside the same caps, mandate tiers and kill switch |

**A new local setup starts at `propose`.** `paper` is one command: `dexterm ai restrictions paper`. **`full` needs a typed confirmation** on a real terminal: `dexterm ai engine ollama --full` explains the small-model risk and asks you to type `ENABLE FULL`. It is recorded for that one model: change the model and the engine runs at `paper` until you confirm again. Going back to a lower profile forgets the confirmation. It needs you at a real terminal: a pipe cannot confirm it.
