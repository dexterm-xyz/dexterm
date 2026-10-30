---
id: docs-classifier-where-it-plugs-in
title: Classification models › Where it plugs in
kind: docs
page: classifier
page_title: Classification models
heading: Where it plugs in
anchor: where-it-plugs-in
url: https://dexterm.xyz/docs/classifier#where-it-plugs-in
tags:
  - docs
  - classifier
  - where
  - plugs
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

- **Agents (MCP)**: `classify_coin` (one coin), `classify_batch` (up to 100 coins, with triage: flag, pass, or escalate the uncertain ones to Claude or to you) and `classifier_status`.
- **Watch rules**: the `rugp` field is the drain estimate of a coin the classifier has scored, for example `when rugp > 0.8 then alert(warn, "classifier: high drain estimate") scope watchlist`. A coin that has not been scored never matches.
- **Research**: the benchmark writes each coin's probabilities as columns, so entry-gate research can test them as one more input.
