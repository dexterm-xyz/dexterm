---
id: docs-strategy-factory-files
title: Strategy factory › Files
kind: docs
page: strategy-factory
page_title: Strategy factory
heading: Files
anchor: files
url: https://dexterm.xyz/docs/strategy-factory#files
tags:
  - docs
  - strategy-factory
  - files
  - strategy
  - factory
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/strategy-factory.md
date: 2026-10-16
---

Everything is under `~/.dexterm/autotrade/factory/` (or `$DEXTERM_HOME`): `factory.json` (your settings), `generated/<id>/` (report, rationale, strategy copy), `lessons.md`, `runs.jsonl` (one line per run), `spend.jsonl` (one line per Claude call), `FACTORY-STOP`, `AGENT-PAUSE` (an agent's pause), `evidence.json` (what an agent may cite), `inbox/` (agent offers), `pending/` (changes waiting for your confirm). The candidates themselves are ordinary strategy files in `~/.dexterm/strategies/`.
