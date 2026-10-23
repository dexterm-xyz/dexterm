---
id: docs-ollama-which-model
title: Use a local model with Ollama › Which model
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Which model
anchor: which-model
url: https://dexterm.xyz/docs/ollama#which-model
tags:
  - docs
  - ollama
  - which
  - model
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

These are tool-capable models from Ollama's library, a good place to start. They are suggestions, not a dexterm benchmark: `dexterm ai probe` checks the copy you pulled.

| model | download | note |
|---|---|---|
| `qwen3:8b` | ~5 GB | a good default on a 16 GB machine |
| `qwen3:14b` | ~9 GB | steadier tool use, needs about 16 GB free |
| `llama3.1:8b` | ~5 GB | a widely used tool caller |
| `mistral-small3.2` | ~15 GB | strong tool use on a 32 GB machine |

Smaller models answer faster and make more mistakes. A model with no tool calling still works for questions (see models without tool calling (https://dexterm.xyz/docs/ollama#models-without-tool-calling)).

dexterm asks Ollama for a 32,768-token context window, or the model's own maximum when that is smaller. On a small machine lower it with `dexterm ai ctx 16384`.
