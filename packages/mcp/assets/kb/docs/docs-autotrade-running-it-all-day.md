---
id: docs-autotrade-running-it-all-day
title: Autotrade (paper) › Running it all day
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Running it all day
anchor: running-it-all-day
url: https://dexterm.xyz/docs/autotrade#running-it-all-day
tags:
  - docs
  - autotrade
  - running
  - all
  - day
  - paper
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/autotrade.md
date: 2026-10-16
---

`dexterm autotrade run` is a headless process: start it in a terminal (or a terminal multiplexer such as `tmux`) and it works until you stop it (https://dexterm.xyz/docs/autotrade#stopping-it), `--max-minutes` runs out, or you press Ctrl+C. A two-hour run is measured under What it costs (https://dexterm.xyz/docs/autotrade#what-it-costs-claude-usage-per-session). Screening uses no model at all, so a runner that is only watching costs no Claude usage; usage starts when a coin matches.

- **One runner per machine.** A second `run` is refused while one is working. A lock left by a runner that crashed is taken over once its process is gone.
- **Each run has its own paper book.** It starts from the strategy's `bankroll`, and a new run starts a fresh one. A run that ends with positions still open says how many on its last line and in its run file; nothing carries them into the next run (the always-on service (https://dexterm.xyz/docs/autotrade#the-always-on-service) carries them over after a crash).
- **In a terminal, leave it open.** A runner started by hand stops when its terminal session ends, and the computer's sleep pauses it. The always-on service below starts it with your login instead.
