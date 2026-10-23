---
id: docs-ollama
title: Use a local model with Ollama
kind: docs
page: ollama
page_title: Use a local model with Ollama
url: https://dexterm.xyz/docs/ollama
tags:
  - docs
  - ollama
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

Run the analyst, your agents and paper autotrade on a free model on your own machine, with no login and no key, behind a restriction profile you choose.

dexterm can run its AI on **a model on your own computer** through Ollama (https://ollama.com), instead of your Claude or Codex login. There is no account, no key and no bill: the model runs on your machine and every answer costs $0. dexterm talks to Ollama on `http://127.0.0.1:11434` by default, so your questions, the screen context and the tool results stay on this machine.

A local engine can do everything the Claude path does: the analyst and its skills, tune-by-chat strategy proposals, the AUTOTRADE runner's sessions, and an agent on the dexterm tools. You decide how far it may go with a **restriction profile**. The limits that protect money are not part of that choice: they are enforced outside the model and are the same for every engine (see what stays outside the model (https://dexterm.xyz/docs/ollama#what-stays-outside-the-model)).
