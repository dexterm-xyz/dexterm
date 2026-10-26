---
id: autotrade-real-signal
title: Real mode: send a strategy's trades to your own executor as LIVE TRADE FIRE signals (dexterm autotrade signal)
kind: app-help
screen: all
feature: autotrade-real-signal
tags:
  - app-help
  - real
  - mode
  - live
  - trade
  - fire
  - signal
  - signals
  - executor
  - webhook
  - hook
  - jsonl
  - receipt
  - receipts
  - arm
  - caps
  - kill
  - outbox
  - nonce
commands:
  - autotrade
tools:
  - trade_fire_feed
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

Real mode runs a strategy exactly like paper (the same clamp, exits, monitor and run file) and sends every buy and sell it fills, first, as a LIVE TRADE FIRE signal (`dexterm-trade-fire/1`: buy or sell, mint, symbol, size in SOL and % of book, the sell fraction and exit reason, strategy, run, account, an always-growing nonce, an idempotency id and an expiry) to YOUR executor: a Telegram trading bot of your choice or any script. dexterm holds no key and signs nothing. Set channels with `dexterm autotrade signal channels --webhook URL | --signal-cmd '["/abs/path"]' | --jsonl on | --mcp on | --telegram on` (they live in connectors.json next to the Telegram setup; a bot cannot read another bot, so the Telegram copy alone is not enough), a webhook HMAC secret with `signal secret generate --out FILE`, hard caps with `signal caps set` (raising needs a typed confirmation), then arm on your own terminal with `dexterm autotrade signal arm <id>` (evidence panel + a typed phrase with a one-time code; any later edit disarms; below the evidence floor, a completed forward test with your `minForwardTrades` closed paper trades and a backtest of these exact rules, or past a missing rung of the ladder, it refuses unless you first type a separate OVERRIDE phrase, which is journaled) and run `dexterm autotrade run <id> --real` (live data only, in the foreground: in 0.2.0 the always-on service runs paper strategies only). Delivery is at least once from a restart-safe outbox, in nonce order, retried until acked or expired; the executor dedupes by nonce, ignores expired signals and acts only on its own account. Every run ends with a `halted` signal that lists the positions still open; the run's last lines and the Telegram copy name them too. Open positions are carried to the next real run of the same strategy and account, whose exits keep firing; while no real run is running NO signal goes out, sells included, so manage them in your executor. Positions stay unconfirmed until `dexterm autotrade receipt <nonce> executed|rejected|failed` (data only). `signal kill` stops every signal; `signal status`, `signal tail`, `receipt list` and `autotrade audit` show the outbox, receipts and drift; agents can read the MCP feed with trade_fire_feed. No model, tool or chat tap can arm real mode, raise a cap or lift the kill switch. Experimental; not financial advice.

CLI: `dexterm autotrade`.
