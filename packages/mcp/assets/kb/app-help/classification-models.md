---
id: classification-models
title: Pick a classification model (Kev, hosted Jev, or the built-in scores)
kind: app-help
screen: all
feature: classifier
tags:
  - app-help
  - classifier
  - classification
  - kev
  - jev
  - model
  - probability
  - rug
  - drain
  - llama
  - calibrated
  - typesafe
  - experimental
commands:
  - classifier
tools:
  - classify_coin
  - classify_batch
  - classifier_status
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

EXPERIMENTAL. A classification model answers typed questions about one coin with a probability per answer: p(drain within 6 h) and RUG / WIN / DUD over 6 h, or a narrative category. `dexterm classifier list` shows the choices: `heuristic` (the built-in H1 rug score and LARP link score; the default, no download), `kev-local` (an open Kev decision model on your own machine through llama.cpp: `dexterm classifier pull kev-4b-q4` shows the size and source and asks first, verifies the sha256, then `dexterm classifier pick kev-local kev-4b-q4` and `dexterm classifier serve`), `jev-hosted` (TypeSafe's hosted Jev with your own API key: `dexterm classifier key set`; per-call cost and a daily call cap), `jev-open` (the open JEV students on a vLLM server), and `claude` / `ollama-llm` zero-shot baselines. `dexterm classifier doctor` reads RAM, CPU and GPU/VRAM and recommends a tier. If the picked model is unreachable the built-in scores answer and say so. Agents use the `classify_coin`, `classify_batch` (triage: flag / pass / escalate) and `classifier_status` MCP tools; a watch rule can use `rugp` (e.g. `when rugp > 0.8 then alert(warn, "...")`). How each model scored on dexterm's own labelled history is on the docs page. Every answer is a model estimate with the model id, never advice. Docs: https://dexterm.xyz/docs/classifier/

CLI: `dexterm classifier`.
