---
id: docs-ollama-autotrade-on-a-local-model
title: Use a local model with Ollama › Autotrade on a local model
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Autotrade on a local model
anchor: autotrade-on-a-local-model
url: https://dexterm.xyz/docs/ollama#autotrade-on-a-local-model
tags:
  - docs
  - ollama
  - autotrade
  - local
  - model
  - use
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/ollama.md
date: 2026-10-16
---

`dexterm autotrade run <strategy> --paper --engine ollama` (or `dexterm ai engine ollama --surface autotrade`) runs each candidate's session on your local model. The session has no tools: the request to Ollama never carries any, so the model can only answer. Its reply is constrained to `{comment, decision}` and turned into the same `DECISION {…}` line a Claude session writes, so the same closed schema, clamp, caps and run file apply. A reply later than the strategy's decision window is no answer. `--model <name>` picks another local model for the run. The run file records `agent: ollama`, the model and $0.

The runner needs the `paper` profile and refuses to start below it, with the command that raises it.
