---
id: autotrade-stop
title: Stop, flatten or audit the autotrade paper runner (dexterm autotrade stop|flatten|audit)
kind: app-help
screen: all
feature: autotrade-runner
tags:
  - app-help
  - autotrade
  - stop
  - kill
  - halt
  - flatten
  - sell
  - pause
  - panic
  - audit
  - verify
  - ledger
  - resume
commands:
  - autotrade
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

`dexterm autotrade stop` is a soft stop of the paper runner: no new entries, every session closed, pending orders dropped, and the mechanical exits (stops, take-profits, trails, rug exits) keep running until nothing is held; then the runner ends. `dexterm autotrade flatten` stops it and sells every paper position at its next tick (a coin that cannot sell is retried every tick); it asks for y on a real terminal, or takes --yes. On the AUTOTRADE screen (`Q`): `!` stops, `p` pauses or resumes new entries, `f` then y flattens. A stop is final for that run. `dexterm wallet panic` is the harder switch: the runner reads it every step, a new run will not start while it is on, and only `dexterm wallet resume` on a real terminal lifts it. `dexterm autotrade audit --verify` recomputes the hash chain of every run file in ~/.dexterm/autotrade/runs/ and names the first edited, missing or reordered line. Paper only; your agent cannot stop, resume or flatten anything. Not financial advice. Full docs: https://dexterm.xyz/docs/autotrade/#stopping-it

CLI: `dexterm autotrade`.
