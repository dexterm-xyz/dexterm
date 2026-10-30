---
id: strategy-dashboard
title: Track how your autotrade strategies perform in a browser, on this machine only (dexterm dash)
kind: app-help
screen: all
tags:
  - app-help
  - dash
  - dashboard
  - performance
  - strategies
  - track
  - equity
  - drawdown
  - compare
  - baseline
  - rugs
  - stuck
  - browser
  - web
  - phone
commands:
  - dash
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

`dexterm dash` reads your own autotrade run ledgers ($DEXTERM_HOME/autotrade/runs) and serves a dashboard on http://127.0.0.1:4317/ (loopback only; no account, no cloud, nothing leaves the machine; read-only). Views: Overview (every strategy side by side with an equity sparkline), Strategy (equity curve, drawdown, exit reasons, open positions with the engine mark and the realizable value from the last cached pool read, every trade), Rugs & stuck (closed at -80% or worse and stuck positions written off at what they actually sold), Compare (each strategy minus a --baseline with the 95% interval of the difference) and Live status; it refreshes every 30 s. Every number carries its sample size; under 20 closed trades a strategy is exploratory. Flags: --port, --home (repeat for several homes), --baseline ID, --books FILE (your own script's books), --allow-host NAME (a private proxy in front), --json, --export DIR [--redact-mints] (a static read-only snapshot). PAPER results are simulated. Not financial advice.

CLI: `dexterm dash`.
