---
id: docs-real-mode-set-it-up
title: Real mode (LIVE TRADE FIRE signals) › Set it up
kind: docs
page: real-mode
page_title: Real mode (LIVE TRADE FIRE signals)
heading: Set it up
anchor: set-it-up
url: https://dexterm.xyz/docs/real-mode#set-it-up
tags:
  - docs
  - real-mode
  - set
  - real
  - mode
  - live
  - trade
  - fire
  - signals
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/real-mode.md
date: 2026-10-16
---

1. **A channel your executor can read** (one or more), saved next to your Telegram setup (https://dexterm.xyz/docs/telegram) in `connectors.json`:

   ```
   dexterm autotrade signal channels --webhook http://127.0.0.1:8787/fire
   dexterm autotrade signal channels --signal-cmd '["/usr/local/bin/my-executor","--fast"]'
   dexterm autotrade signal channels --jsonl on
   dexterm autotrade signal channels --mcp on
   dexterm autotrade signal channels --telegram on --ttl 60
   ```

   `off` turns one off. `dexterm telegram status` shows the channels too.
2. **A webhook secret** (recommended for the webhook): `dexterm autotrade signal secret generate --out /path/for/your/executor.secret` makes a random secret, keeps it in your keychain (like the bot token) and writes it to that file (0600) for your executor. It is never printed. `secret set` reads one from a pipe; `secret remove` deletes it.
3. **Your limits**: `dexterm autotrade limits set perTradeSol=0.25 dailySol=1 buysPerDay=20 maxOpenPositions=3 dailyLossSol=0.5`, and any of the others (Going real, safely (https://dexterm.xyz/docs/going-real#your-limits)): per trade in SOL or % of book, exposure, position size, per coin, loss stops, the drawdown breaker, max hold, floors, slippage, TTL, rate. You can set them globally, per mode, per strategy or per account, and the stricter wins. Raising any of them asks for a typed confirmation on your terminal; lowering does not. The numbers shown are placeholders. `signal caps set --per-trade-sol …` still sets the first four.
4. **Arm the strategy** on your own terminal: `dexterm autotrade signal arm my-strategy [--account main]`. On a first arming it asks for your own limits (Enter keeps a placeholder). Then you see the evidence panel: the last backtest of this version, a forward-test report if there is one, the limits in force for this strategy and account, your executor's health and the channels. Then you type the phrase it shows, which confirms those limits, with its one-time code (`REAL my-strategy 7KQ4`). **The evidence floor**: arming needs a completed forward test of these exact rules with at least 10 closed paper trades (your limit `minForwardTrades`) and a backtest on record. Below it, or when arming now would skip a rung of the ladder (https://dexterm.xyz/docs/build-a-strategy-by-chat#the-ladder), arming refuses and says what is missing; only you can go on anyway, by first typing a separate phrase it shows (`OVERRIDE my-strategy 3HXR`, its own one-time code). The override is journaled. No model, tool, flag or pipe can give it. Arming saves the strategy as a new version in mode `real`, and the arming is bound to that exact version: any later edit disarms it. Presets cannot be armed; copy one with `dexterm autotrade new` first.
5. **Test the channels**: `dexterm autotrade signal test` sends a `test` signal (`test: true`, no coin: nothing to trade) through each channel and shows, per channel, delivered or not, the latency, and your executor's receipt. The dry-run executor kit (https://dexterm.xyz/docs/going-real#the-executor-kit) answers it out of the box.
6. **Run it**: `dexterm autotrade run my-strategy --real`. In 0.2.0 real mode runs **in the foreground only**: the always-on service runs paper strategies, never a real one. Real mode runs on live data only (a replay would send old prices to your executor). `--sol-usd N` fixes the SOL price for sizes in SOL; without it dexterm reads SOL/USD from DexScreener (keyless) and refuses to start without one.

`dexterm autotrade signal disarm my-strategy` puts it back on paper. `dexterm autotrade run my-strategy --paper` runs a real strategy's paper twin: no signal goes out. `run --all` stays paper: a real strategy runs on its own.
