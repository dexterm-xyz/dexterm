---
id: docs-ollama-your-own-agent-on-the-local-model
title: Use a local model with Ollama › Your own agent, on the local model
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Your own agent, on the local model
anchor: your-own-agent-on-the-local-model
url: https://dexterm.xyz/docs/ollama#your-own-agent-on-the-local-model
tags:
  - docs
  - ollama
  - own
  - agent
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

`dexterm ai agent "<goal>"` runs the local model as an agent on the dexterm MCP server, the way `claude -p` connected to `dexterm mcp` would: the read tools at every profile, proposals at `propose`, and the paper tools at `paper` (the server still refuses them unless you armed a mandate and turned on agent paper trading in the app). `--thoughts FILE` writes its words for the spectator (https://dexterm.xyz/docs/spectator)'s thought ribbon (`--spectate-thoughts FILE`).
