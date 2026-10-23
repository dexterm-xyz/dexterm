---
id: docs-ollama-how-we-checked
title: Use a local model with Ollama › How we checked
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: How we checked
anchor: how-we-checked
url: https://dexterm.xyz/docs/ollama#how-we-checked
tags:
  - docs
  - ollama
  - checked
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

Offline tests drive a fake Ollama server through the real app paths and the real dexterm MCP server: tool round trips, the tool list each profile offers, refused calls that never run, the no-tools mode, structured verdicts, the typed `full` confirmation, and the doctor lines. The firewall test checks the local model receives exactly the text the Claude CLI receives. The caps test runs the same decisions through the Claude path's session interface and a local session over a recorded tape and gets identical clamps, refusals and fills. Answer quality and speed of local models against Claude have not been benchmarked.
