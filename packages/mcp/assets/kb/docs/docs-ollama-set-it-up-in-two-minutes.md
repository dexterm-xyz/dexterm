---
id: docs-ollama-set-it-up-in-two-minutes
title: Use a local model with Ollama › Set it up in two minutes
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Set it up in two minutes
anchor: set-it-up-in-two-minutes
url: https://dexterm.xyz/docs/ollama#set-it-up-in-two-minutes
tags:
  - docs
  - ollama
  - set
  - two
  - minutes
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

```
1. install Ollama            https://ollama.com/download   (open it once so it runs)
2. ollama pull qwen3:8b      about 5 GB, once
3. dexterm ai engine ollama  run dexterm's AI on the local engine
4. dexterm ai model qwen3:8b
5. dexterm doctor            the "Ollama (local AI)" line should be a ✓
```

Then press `a` on a coin, or type a question, as usual. The panel title says `ANALYST · ollama` and the caption under an answer shows `local $0`. In the chat box, `/engine ollama` switches new conversations to the local model and `/engine claude` switches back.

dexterm never downloads or ships a model: you pull the one you want with Ollama.
