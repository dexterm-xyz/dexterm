---
id: autotrade-executor-kit
title: Wire up a test executor, check it is alive, and get the digest (dexterm autotrade executor, signal test, report)
kind: app-help
screen: all
feature: autotrade-executor-kit
tags:
  - app-help
  - executor
  - kit
  - example
  - heartbeat
  - alive
  - silent
  - health
  - test
  - webhook
  - receiver
  - dry
  - run
  - digest
  - report
  - daily
  - weekly
  - divergence
  - slippage
  - latency
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

`dexterm autotrade executor kit --out ~/my-executor` copies the reference executors: a webhook receiver, a `--signal-cmd` hook and a JSONL tail. Each verifies the HMAC, dedupes by nonce, honours the TTL, writes a receipt and a heartbeat, and is DRY RUN: it only logs what it would do, with no wallet code in it. Start one, point a channel at it (`dexterm autotrade signal channels --webhook http://127.0.0.1:8787/signal`), then `dexterm autotrade signal test` sends a test signal (`test: true`, no coin, nothing to trade) and shows, per channel, whether it was delivered, how long it took and the executor's receipt. `dexterm autotrade executor status` shows the last heartbeat, the last receipt and the lag; a real run pauses new buy signals (exits still go out) when nothing is heard for longer than your `executorSilenceMin` limit, and tells you. With receipts that carry fills, `signal status`, `autotrade audit` and `dexterm autotrade report` show paper vs real: slippage against dexterm's own paper fill, latency, partial fills and rejections. `report [--period day|week] [--telegram]` is the digest per strategy and mode with the win rate's interval and a small-sample note; `report --schedule daily|weekly` makes a run with your bot on send it.

CLI: `dexterm autotrade`.
