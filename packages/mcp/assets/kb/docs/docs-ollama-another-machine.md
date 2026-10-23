---
id: docs-ollama-another-machine
title: Use a local model with Ollama › Another machine
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: Another machine
anchor: another-machine
url: https://dexterm.xyz/docs/ollama#another-machine
tags:
  - docs
  - ollama
  - another
  - machine
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

`dexterm ai host http://<machine>:11434` points dexterm at an Ollama on another computer you control. Prompts, screen context and tool results then travel over your network, and `dexterm ai status`, `dexterm doctor` and each chat answer say so. dexterm contacts no other host for the local engine. It never follows a redirect: if the host answers with one, dexterm sends nothing on, and `dexterm doctor` and the chat answer say the host redirected.
