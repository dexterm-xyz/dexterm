---
id: docs-ollama-pick-the-engine-globally-or-per-surface
title: Use a local model with Ollama › Pick the engine, globally or per surface
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Pick the engine, globally or per surface
anchor: pick-the-engine-globally-or-per-surface
url: https://dexterm.xyz/docs/ollama#pick-the-engine-globally-or-per-surface
tags:
  - docs
  - ollama
  - pick
  - engine
  - globally
  - per
  - surface
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

`dexterm ai engine <auto|claude|codex|ollama>` sets the engine for everything; add `--surface analyst|autotrade|agent` to set one surface only (for example the analyst on Claude and paper autotrade on the local model). `dexterm ai status` shows the engine for each surface, the local model, the profile and a quick probe; `dexterm ai status --parity` adds the full list of what runs where.

For the analyst the order is: `--analyst-engine`, then `DEXTERM_ANALYST_ENGINE`, then `analyst.engine` in `config.json`, then `ai.json`, then `auto`. **`auto` is unchanged**: Claude Code when it is installed, else Codex, else the local model once you set one up (or Ollama is installed). With none of them, the analyst says how to set up an AI backend, and `dexterm doctor` lists all three ways.

The settings live in `~/.dexterm/ai.json` (mode 0600). Only you write it, with `dexterm ai …` or by hand. No MCP tool, chat message, Telegram command or model output can change it.

| setting | how |
|---|---|
| engine | `dexterm ai engine ollama` · `DEXTERM_AI_PROVIDER` · per surface `--surface S` |
| model | `dexterm ai model <name>` · `DEXTERM_OLLAMA_MODEL` (when none is set dexterm picks the first suggested model you pulled) |
| host | `dexterm ai host <url>` · `DEXTERM_OLLAMA_HOST` (default `http://127.0.0.1:11434`) |
| context | `dexterm ai ctx <tokens>` |
| profile | `dexterm ai restrictions observe|propose|paper` · `dexterm ai engine ollama --full` · `DEXTERM_AI_RESTRICTIONS` can only lower it |
