---
id: docs-classifier-the-choices
title: Classification models › The choices
kind: docs
page: classifier
page_title: Classification models
heading: The choices
anchor: the-choices
url: https://dexterm.xyz/docs/classifier#the-choices
tags:
  - docs
  - classifier
  - choices
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

| provider | what it is | runs where | cost |
|---|---|---|---|
| `heuristic` | the built-in scores: the H1 rug score and the LARP link score | inside dexterm | $0, instant |
| `kev-local` | Kev, an open decision model (Apache-2.0), run by llama.cpp | your machine | $0 per call after the download |
| `jev-hosted` | Jev, TypeSafe's hosted flagship decision model | TypeSafe's API, with **your own** key | per call, on your TypeSafe account |
| `jev-open` | the open JEV students (`autotrust/JEV-*`, Apache-2.0) on a vLLM server | your GPU server (24 GB or more) | $0 per call |
| `claude`, `ollama-llm` | a chat model asked for probabilities (a comparison baseline) | your Claude CLI / your Ollama | your plan / $0 |

A decision model reads the coin's facts once and scores every answer in one pass, without writing text. That is why it can be fast enough to score a whole screener.

The default is `heuristic`: dexterm downloads nothing and calls nothing on first run.
