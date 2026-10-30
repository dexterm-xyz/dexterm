---
id: docs-classifier-set-up-kev-on-your-own-machine
title: Classification models › Set up Kev on your own machine
kind: docs
page: classifier
page_title: Classification models
heading: Set up Kev on your own machine
anchor: set-up-kev-on-your-own-machine
url: https://dexterm.xyz/docs/classifier#set-up-kev-on-your-own-machine
tags:
  - docs
  - classifier
  - set
  - kev
  - own
  - machine
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

```
1. dexterm classifier doctor               your RAM, CPU and GPU, and the model tier it recommends
2. dexterm classifier pull kev-4b-q4       shows the size and the source, asks, checks the disk, verifies the sha256
3. dexterm classifier pick kev-local kev-4b-q4
4. dexterm classifier serve                runs llama-server on 127.0.0.1 (leave it open)
5. dexterm classifier try                  one labelled estimate, to see it work
```

You need llama.cpp's `llama-server` from a build released on 2026-10-02 or later: that is when it gained the `/v1/systemone` endpoint decision models use. Put it on your `PATH`, or point `DEXTERM_LLAMA_SERVER` at it. Downloads come from the pinned revision of the model's Hugging Face repo and are checked against a sha256 before use. Once a model is downloaded, it works fully offline.

If the picked model is not running, the built-in scores answer instead, and the answer says it is a fallback.
