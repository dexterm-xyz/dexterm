---
id: docs-ollama-troubleshooting
title: Use a local model with Ollama › Troubleshooting
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Troubleshooting
anchor: troubleshooting
url: https://dexterm.xyz/docs/ollama#troubleshooting
tags:
  - docs
  - ollama
  - troubleshooting
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

| message | fix |
|---|---|
| `ollama is not running` | open the Ollama app or run `ollama serve`, then `dexterm doctor` |
| `no local model pulled` | `ollama pull qwen3:8b` then `dexterm ai model qwen3:8b` |
| `ollama model … is not pulled` | `ollama pull <model>` |
| `the local model took too long` | a smaller model answers faster; `dexterm ai status` lists yours |
| `… did not return the structured verdict` | ask again, or pull a larger tool-capable model |
| `the local engine's restriction profile is propose; an autotrade run needs paper` | `dexterm ai restrictions paper` |
| `full was confirmed for …, not …` | `dexterm ai engine ollama --full` again for the new model |
