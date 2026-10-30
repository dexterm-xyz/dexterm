---
id: docs-classifier-settings
title: Classification models › Settings
kind: docs
page: classifier
page_title: Classification models
heading: Settings
anchor: settings
url: https://dexterm.xyz/docs/classifier#settings
tags:
  - docs
  - classifier
  - settings
  - classification
  - models
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/classifier.md
date: 2026-10-16
---

`~/.dexterm/classifier.json` (0600). Only `dexterm classifier` writes it.

| key | what it does |
|---|---|
| `provider` | `heuristic` (default), `kev-local`, `jev-hosted`, `jev-open`, `claude`, `ollama-llm` |
| `default` | the shipped recommendation for a local model |
| `kev.endpoint`, `kev.model`, `kev.threads` | the local server (loopback only) and the model id |
| `jev.endpoint`, `jev.model`, `jev.pricePerMTokUsd`, `jev.maxCallsPerDay` | hosted Jev |
| `calibration` | optional Platt maps per model and question, fitted on labelled rows |
| `fallback` | answer with the built-in scores when the provider is unreachable (default `true`) |
