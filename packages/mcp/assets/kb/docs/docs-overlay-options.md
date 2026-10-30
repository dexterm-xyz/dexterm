---
id: docs-overlay-options
title: Streamer overlay (OBS) › Options
kind: docs
page: overlay
page_title: Streamer overlay (OBS)
heading: Options
anchor: options
url: https://dexterm.xyz/docs/overlay#options
tags:
  - docs
  - overlay
  - options
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

| Option | What it does |
|---|---|
| `--scene NAME` | `activity`, `coin`, `pnl` or `all`; repeat it for several. Default: the three scenes |
| `--theme NAME` | `cyberspace` (phosphor green, the app's default look), `ice` (electric cyan) or `neon` (magenta). Default `cyberspace` |
| `--replay FILE` | Play a saved spectator session instead of the live stream. Every scene says SAMPLE DATA |
| `--speed N` | Replay speed (default 1); gaps between calls are capped at 5 s |
| `--loop` | Replay again from the start; the final scenes hold for 10 s first |
| `--ledger TRADE_ID` | The PnL scene shows one round trip from your own trade ledger (https://dexterm.xyz/docs/paper-trading#the-trade-ledger) (`dexterm ledger trades` lists the ids) instead of the agent's paper fills. `--sol-usd N` for a USD-booked trade |
| `--port N` | A fixed loopback port (1024 to 65535) instead of a random one |
| `--ticket-ttl MIN` | Minutes an unused URL stays valid (default 10) |
| `--json` | Print the scene URLs as JSON |
