---
id: docs-classifier-which-model-for-which-machine
title: Classification models › Set up Kev on your own machine › Which model for which machine
kind: docs
page: classifier
page_title: Classification models
heading: Which model for which machine
anchor: which-model-for-which-machine
url: https://dexterm.xyz/docs/classifier#which-model-for-which-machine
tags:
  - docs
  - classifier
  - which
  - model
  - machine
  - set
  - kev
  - own
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

`dexterm classifier doctor` reads your RAM, CPU and GPU and suggests one of these:

| your machine | suggestion | what to expect |
|---|---|---|
| NVIDIA GPU with 12 GB or more | `kev-4b-q4` (`kev-9b-q4` also fits) | Kev 9B took about 0.1-0.2 s per coin on an RTX 4080 but scored no better than Kev 4B (see below) |
| NVIDIA GPU with 6 GB or more | `kev-4b-q4` (3 GB download) | |
| Apple Silicon with 16 GB or more | `kev-4b-q4` | |
| A CPU with 16 GB of RAM and 8 threads or more | `kev-4b-q4`, for one coin at a time | 5-20 s per coin measured on shared desktop CPUs: fine for a coin you open, too slow to score a whole screener |
| Anything smaller | the built-in scores | |

`kev-0.8b-q8` is in the list but not suggested: on dexterm's own history it ranked coins no better than chance.
Serving uses about 2.5 GB of RAM for the 0.8B model and about 5.5 GB for the 4B model; the 9B model used about 6.6 GB of GPU memory.
