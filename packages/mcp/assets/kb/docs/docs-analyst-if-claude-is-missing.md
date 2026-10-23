---
id: docs-analyst-if-claude-is-missing
title: The analyst › If claude is missing
kind: docs
page: analyst
page_title: The analyst
heading: If claude is missing
anchor: if-claude-is-missing
url: https://dexterm.xyz/docs/analyst#if-claude-is-missing
tags:
  - docs
  - analyst
  - claude
  - missing
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

The panel says to set up an AI backend, with both ways in one line (`npm i -g @anthropic-ai/claude-code && claude login`, or a free local model with Ollama), and the rest of dexterm keeps working. `dexterm doctor` reports the Claude CLI line as a warning, not a failure. With Codex installed, `auto` runs the analyst on Codex instead; with neither but a local model (https://dexterm.xyz/docs/ollama) set up, on the local model.
