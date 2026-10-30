---
id: docs-overlay-before-you-start
title: Streamer overlay (OBS) › Before you start
kind: docs
page: overlay
page_title: Streamer overlay (OBS)
heading: Before you start
anchor: before-you-start
url: https://dexterm.xyz/docs/overlay#before-you-start
tags:
  - docs
  - overlay
  - before
  - start
  - streamer
  - obs
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/overlay.md
date: 2026-10-16
---

You need an agent session to watch. Pick one:

- **An agent connected over MCP** (Claude Code, Cursor, Codex, …): run the app with `dexterm --spectate-mcp`. Your terminal follows the agent and opens the read-only spectator stream. See follow over MCP (https://dexterm.xyz/docs/spectator#follow-over-mcp-in-the-running-terminal).
- **An agent on the loopback bus**: `dexterm agent serve --spectate`. See bring your own agent (https://dexterm.xyz/docs/agents).
- **No agent, a dry run or a rehearsal**: a saved session with `--replay FILE` (record one with `dexterm agent serve --record FILE`). Every scene then carries a yellow **SAMPLE DATA · REPLAY** tag.

The overlay finds the live stream on its own (the same `spectator.json` that `dexterm spectate --info` reads), waits for it if it is not up yet, and reconnects when it restarts.
