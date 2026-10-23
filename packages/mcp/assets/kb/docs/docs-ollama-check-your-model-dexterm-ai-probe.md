---
id: docs-ollama-check-your-model-dexterm-ai-probe
title: Use a local model with Ollama › Check your model: dexterm ai probe
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Check your model: dexterm ai probe
anchor: check-your-model-dexterm-ai-probe
url: https://dexterm.xyz/docs/ollama#check-your-model-dexterm-ai-probe
tags:
  - docs
  - ollama
  - check
  - model
  - dexterm
  - probe
  - use
  - local
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/ollama.md
date: 2026-10-16
---

`dexterm ai probe` checks that Ollama answers, the model is pulled, it can call tools, and how much context it has. `dexterm ai probe --json` also asks it three short trading questions and checks it answers in the decision format the AUTOTRADE runner needs. It warns when the model is below the bar for your profile:

| profile | tool calling | context | decision format |
|---|---|---|---|
| `observe` | optional | ≥ 4,096 | not needed |
| `propose` | yes | ≥ 8,192 | not needed |
| `paper` | yes | ≥ 8,192 | 2 of 3 |
| `full` | yes | ≥ 16,384 | 3 of 3 |

A decision a model cannot format is refused by the engine, which means fewer trades, never bigger ones.
