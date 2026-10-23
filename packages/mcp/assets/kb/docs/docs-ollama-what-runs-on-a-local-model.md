---
id: docs-ollama-what-runs-on-a-local-model
title: Use a local model with Ollama › What runs on a local model
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: What runs on a local model
anchor: what-runs-on-a-local-model
url: https://dexterm.xyz/docs/ollama#what-runs-on-a-local-model
tags:
  - docs
  - ollama
  - runs
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

| surface | on the local model |
|---|---|
| analyst chat and follow-ups | the same dexterm MCP server and tools, the same firewalled context, answers streamed word by word |
| structured skills (dossier, rug-check, larp-check, trench-scan) | the same playbook, then Ollama's structured output on the same schema |
| AI scan mode (https://dexterm.xyz/docs/scan) | observe-only, at the tool list, the MCP server and the app |
| Jarvis voice questions | asked through the same analyst, on whichever engine `/engine` picked |
| `dexterm ask "…"` | a headless question on the analyst's engine |
| tune by chat | `strategy_propose_edit` / `strategy_propose_new` at `propose`; you apply with `y` as always |
| AUTOTRADE runner sessions | `dexterm autotrade run <strategy> --paper --engine ollama`: the same DOSSIER, DELTA and EVENT messages and the same typed decision, at `paper` |
| an agent on the dexterm tools | `dexterm ai agent "<goal>"`, tools by profile |
| Telegram approvals, the agent bus | engine-independent: approvals are your taps; bus agents bring their own model |

The Claude usage guard does not apply to a local model (no plan limit, $0); the runner's day caps on sessions and turns still do.
