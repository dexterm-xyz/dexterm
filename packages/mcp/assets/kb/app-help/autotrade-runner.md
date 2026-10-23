---
id: autotrade-runner
title: The autotrade paper runner and candidate sessions (dexterm autotrade run)
kind: app-help
screen: all
feature: autotrade-runner
tags:
  - app-help
  - autotrade
  - runner
  - run
  - candidate
  - session
  - sessions
  - agent
  - replay
  - ledger
  - runner.json
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

`dexterm autotrade run <id|file> --paper` runs one strategy on paper, headless, one runner per machine: the screener feeds it the same live data as the app (every 10 s, candidate and held coins every 5 s), and each coin that matches gets one session on your own Claude login with the full picture first, then only what changed. Your agent answers with a typed decision (enter, wait, skip, hold, exit, tighten, reprofile); every size is clamped by your strategy and the exits run on their own. At most 2 sessions at once, $0.50 per session and the day caps in ~/.dexterm/autotrade/runner.json (which Claude account, sessions and spend per day, a usage guard). Every step goes to ~/.dexterm/autotrade/runs/<run>.jsonl, hash-chained. `--replay FILE` paces a recorded tape instead of live data; `--stub` uses a scripted agent with no Claude cost. Paper only: a run never signs or touches a wallet, and there is no `--live` (dexterm holds no key and places no live order). Not financial advice. Full docs: https://dexterm.xyz/docs/autotrade/#the-runner-and-candidate-sessions

CLI: `dexterm autotrade`.
