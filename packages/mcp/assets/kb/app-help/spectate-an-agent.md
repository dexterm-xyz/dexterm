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
  - mcp
  - follow
commands:
  - spectate
flags:
  - --replay
  - --spectate-mcp
  - --spectate-thoughts
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

Watch an agent work. For an agent on the loopback bus, `dexterm agent serve --spectator-popup` opens the AGENT ACTIVITY window, `--spectate` starts the read-only, token-gated, loopback stream, and `--record FILE` saves a redacted session. For an agent connected over MCP (`dexterm mcp install`), run the app with `dexterm --spectate-mcp`: the running terminal follows the agent and an agent dock appears under the screen — a phase rail (SCANNING > VETTING > SIZING > EXECUTING > HOLDING > EXITING) with a heartbeat, the call timeline with result chips, the rows it scans glow and a cursor marks the coin it opens, a vetting card fills its checks and LARP evidence, and a PAPER trade shows its ticket, the fill, a live position with the mark PnL and a result card. `--spectate-thoughts FILE` streams the agent's own words into a thought ribbon from a JSONL file it writes (for example `claude -p --output-format stream-json`); display only. PAPER is always on screen; ctrl+p pauses, ctrl+k kills (a hard stop) and any key you press takes control; calm mode drops the motion. While the agent is active, the token screen's analyst panel is its BRAIN VIEW: the reasoning stream with phase tags (or dexterm's narration when there is no thoughts feed), the vetting checklist with the app's numbers and pass/warn/fail/pending, a data strip, the PAPER plan and position, and the session's decision log with a simulated scoreboard. While it holds a PAPER position, a PnL chip shows coin, PnL, entry to mark, peak, drawdown, time held and the take-profit it said, on every terminal screen (in the dock, or on the band under the header on terminals under 24 rows) and on the chart popup; display only. `dexterm spectate --replay FILE` replays a saved session step by step and `dexterm spectate --info` shows the live stream endpoint. Every shared copy is redacted — a tool name, refusal, agent line or navigation can never leak a wallet or key — and a spectator can only watch, never act. Full docs: https://dexterm.xyz/docs/spectator/

CLI: `dexterm spectate`.
