---
id: autotrade-web
title: The Strategy Builder in your browser: strategies, builder, factory, chat and Watch it cook (paper)
kind: app-help
screen: all
feature: autotrade-web
tags:
  - app-help
  - autotrade
  - strategy
  - web
  - browser
  - builder
  - ui
  - watch
  - cook
  - overlay
  - localhost
commands:
  - autotrade
  - strategies
tools:
  - strategy_overview
  - factory_status
  - strategy_change
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

`dexterm autotrade web` (or `dexterm strategies web`) opens the Strategy Builder in your browser, on this machine only (127.0.0.1, a free port). The link it prints works ONCE: it becomes a session cookie, and a fresh link (press n) ends the old session. Four tabs. Strategies: every strategy with its ladder stage (draft, backtested, forward-tested, always-on paper), GENERATED tags for the factory's candidates (most fail), its rules in plain words and its numbers exactly as dexterm's stats return them (held-out test, the factory's evidence window, backtest, forward test, running paper account; a dash = none). Builder: edit entry gates, sizing, the exit ladder (gain or market-cap rungs, the moonbag) and caps by form with a live check; it writes a PROPOSAL you apply (a LOOSER edit asks twice), and runs a backtest or a paper forward test. Factory: status, spend against the caps, candidates by stage, lessons.md, Pause / Resume / Run now / Retire (each a preview, then your Confirm); FACTORY-STOP is shown and only your terminal lifts it (`dexterm autotrade factory resume`). Chat: the in-app assistant and its tools on your own Claude (capped per turn); a change shows as a preview card with Confirm / Cancel. Watch it cook opens a new terminal window running `dexterm autotrade watch <id>`: read-only, the strategy overlay (rules, bags HELD/SOLD, entries and exits, paper equity, ladder rungs hit), also served as the overlay `strategy` scene; it attaches to a running spectator session instead of starting one. No route or chat tool reaches real mode, arming, your real-mode limits, the paper book, the daily Claude budget, signing or sending (a strategy's own caps and per-session Claude settings change only through a proposal you apply; a looser one asks twice); Host, Origin and a CSRF token are checked on every change; responses redact addresses and keys. Paper and simulated; not financial advice.

CLI: `dexterm autotrade`, `dexterm strategies`.
