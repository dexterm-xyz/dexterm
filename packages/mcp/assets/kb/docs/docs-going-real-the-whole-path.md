---
id: docs-going-real-the-whole-path
title: Going real, safely › The whole path
kind: docs
page: going-real
page_title: Going real, safely
heading: The whole path
anchor: the-whole-path
url: https://dexterm.xyz/docs/going-real#the-whole-path
tags:
  - docs
  - going-real
  - whole
  - path
  - going
  - real
  - safely
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/going-real.md
date: 2026-10-16
---

> **0.2.0, experimental.** Real mode can lead to real trades in a wallet you fund. dexterm never holds a key, never signs and never sends a transaction. Your executor does, by its own rules. Not financial advice.

1. **Build and test on paper.** Make a strategy (from a preset, by chat, or in a file), backtest it on your recorded history, then forward-test it on paper on live data (`dexterm autotrade forward start my-strategy --hours 24`). Arming for real needs a completed forward test with at least 10 closed paper trades and a backtest (the evidence floor, `minForwardTrades`). Paper is the default for every new strategy.
2. **Wire up an executor, dry run.** Copy the executor kit (https://dexterm.xyz/docs/going-real#the-executor-kit), start one of its executors, point a channel at it, and send a test signal. Nothing can trade yet.
3. **Set your own limits.** `dexterm autotrade limits set …` (your limits (https://dexterm.xyz/docs/going-real#your-limits)). The defaults are placeholders, and your numbers win.
4. **Arm on your own terminal.** `dexterm autotrade signal arm my-strategy`. On a first arming dexterm asks for your numbers, then shows the evidence (backtest, forward test), the limits in force for this strategy and account, and your executor's health. Typing the phrase it shows confirms all of it. Below the evidence floor, or past a missing rung of the ladder, it refuses unless you first type a separate OVERRIDE phrase, which is journaled.
5. **Run it real.** `dexterm autotrade run my-strategy --real`, in the foreground (in 0.2.0 the always-on service runs paper strategies only). Every buy and sell goes to your executor as a LIVE TRADE FIRE signal (https://dexterm.xyz/docs/real-mode#the-signal), inside your limits. When no real run is running, no signal goes out, sells included: positions still open at the end are printed, listed in the `halted` signal and carried (https://dexterm.xyz/docs/real-mode#the-channels) to the next real run; until then, manage them in your executor.
6. **Watch and calibrate.** `signal status`, the `Q` screen and your Telegram chat show the limits, the executor's health and how far real fills land from paper. The digest (https://dexterm.xyz/docs/going-real#the-digest) sums it up each day or week.

At any point, `dexterm autotrade signal kill` stops every signal, sells included (one final `halted` still goes out, listing the positions still open; it closes nothing), and `dexterm autotrade signal disarm my-strategy` puts the strategy back on paper.
