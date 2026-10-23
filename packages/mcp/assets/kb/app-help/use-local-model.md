---
id: use-local-model
title: Run dexterm's AI on a free local model (Ollama)
kind: app-help
screen: all
feature: analyst
tags:
  - app-help
  - ollama
  - local
  - model
  - free
  - offline
  - engine
  - llama
  - qwen
  - restrictions
  - privacy
commands:
  - ai
  - ask
flags:
  - --analyst-engine
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

dexterm's AI can run on a free model on your own machine through Ollama: no login, no key, $0 per answer, and it talks only to http://127.0.0.1:11434 by default. Set it up in two minutes: install Ollama (https://ollama.com/download), `ollama pull qwen3:8b`, `dexterm ai engine ollama`, `dexterm ai model qwen3:8b`, then `dexterm doctor` (the Ollama line should pass). In the chat box `/engine ollama` switches new conversations, `/engine claude` switches back; `--analyst-engine ollama` and `DEXTERM_ANALYST_ENGINE=ollama` work too, and `dexterm ai engine ollama --surface autotrade` picks one surface. The local engine uses the same dexterm tools and the same firewalled context as Claude. What it may do is your restriction profile: `observe` (analyse only), `propose` (the default for a new setup: UI actions, a PAPER ticket you confirm, strategy proposals you apply), `paper` (adds paper autotrade sessions and agent paper trading in a mandate you armed: `dexterm ai restrictions paper`), `full` (only after `dexterm ai engine ollama --full` and typing ENABLE FULL, for one model). Caps, the kill switch, mandate tiers, live gating and Telegram buttons are enforced outside the model for every engine. `dexterm ai probe --json` checks tool calling, context and decision formatting; a model without tools answers from the dossier dexterm fetches and says so. Paper autotrade on it: `dexterm autotrade run <strategy> --paper --engine ollama`. Headless: `dexterm ask "question"`, `dexterm ai agent "goal"`. Docs: https://dexterm.xyz/docs/ollama/

CLI: `dexterm ai`, `dexterm ask`.
