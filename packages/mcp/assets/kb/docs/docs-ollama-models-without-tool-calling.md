---
id: docs-ollama-models-without-tool-calling
title: Use a local model with Ollama › Models without tool calling
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Models without tool calling
anchor: models-without-tool-calling
url: https://dexterm.xyz/docs/ollama#models-without-tool-calling
tags:
  - docs
  - ollama
  - models
  - without
  - tool
  - calling
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

If the model cannot call tools, dexterm fetches the selected coin's dossier itself and the model answers from it, and the answer starts with `(… has no tool calling: answering from the dossier without tools)`. Structured verdicts carry a `no_tools_mode` flag. For tool use pull a tool-capable model (the table above).

A local model that keeps asking for a tool it does not have is refused each time (the call never runs); after three refusals the turn stops and says so.
