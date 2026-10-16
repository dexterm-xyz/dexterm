---
id: spectate-an-agent
title: Watch an agent drive dexterm (dexterm spectate)
kind: app-help
screen: all
feature: spectator
tags:
  - app-help
  - spectate
  - spectator
  - watch
  - agent
  - cook
  - observe
  - replay
  - stream
  - record
commands:
  - spectate
flags:
  - --replay
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

`dexterm spectate --replay FILE` replays a saved agent session so you can watch what an agent did step by step; `dexterm spectate --info` shows the live read-only, token-gated, loopback spectator stream. The stream is redacted — a tool name, refusal, agent line or navigation can never leak a wallet or key — and a spectator can only watch, never act.

CLI: `dexterm spectate`.
