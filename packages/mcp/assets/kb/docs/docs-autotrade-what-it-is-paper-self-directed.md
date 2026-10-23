---
id: docs-autotrade-what-it-is-paper-self-directed
title: Autotrade (paper) › What it is (paper, self-directed)
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: What it is (paper, self-directed)
anchor: what-it-is-paper-self-directed
url: https://dexterm.xyz/docs/autotrade#what-it-is-paper-self-directed
tags:
  - docs
  - autotrade
  - paper
  - self-directed
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/autotrade.md
date: 2026-10-16
---

Autotrade (paper) is a strategy file plus an engine that replays it. You write the rules: which coins count as candidates, how a position is sized, how it is exited, and how much loss is allowed. The engine applies exactly those rules, and every size is clamped by them. It runs on **paper** by default: there is no key, wallet or signer anywhere in a strategy, and a paper run never signs or sends anything. A strategy that says `"mode": "live"` validates with a warning and runs only with `dexterm autotrade run --live`, through the live signer (https://dexterm.xyz/docs/live-trading) and its caps (experimental, can lose all the funds in the trading wallet).

It is self-directed: your strategies, on your machine, with your own recorded history. Nobody runs a strategy for you, and a preset is an example, not a recommendation.

What ships today, covered below:

- Strategies and presets (https://dexterm.xyz/docs/autotrade#strategies-and-presets): presets, your own strategy files, validation and the change journal, on the command line or on the `Q` screen (https://dexterm.xyz/docs/autotrade#on-the-q-screen).
- Backtests and their limits (https://dexterm.xyz/docs/autotrade#backtests-and-their-limits): replays on recorded history, the held-out check, and what the data cannot tell you.
- The runner and candidate sessions (https://dexterm.xyz/docs/autotrade#the-runner-and-candidate-sessions): `dexterm autotrade run --paper`, your own Claude working each candidate the screener finds, every size clamped by your strategy.
- Exits and wakes (https://dexterm.xyz/docs/autotrade#exits-and-wakes): the exits that run on their own, the judgement calls your agent is woken for, and what it can and cannot do with them.
- Change a strategy by chat (https://dexterm.xyz/docs/autotrade#change-a-strategy-by-chat): the analyst proposes, you see the diff and apply it with a key (a less-safe change needs a second key).
- Running it all day (https://dexterm.xyz/docs/autotrade#running-it-all-day): how long a run lasts, which Claude account it uses, the day caps and the usage guard.
- Stopping it (https://dexterm.xyz/docs/autotrade#stopping-it): a soft stop, a flatten and the panic switch, the heartbeat, and checking the record of a run.
- What it costs (https://dexterm.xyz/docs/autotrade#what-it-costs-claude-usage-per-session): the Claude usage of a session, measured.
- What it will not do (https://dexterm.xyz/docs/autotrade#what-it-will-not-do): live money, copy-trading automation, managing anyone else's money.

On your phone: your own Telegram bot (https://dexterm.xyz/docs/telegram) sends the entries, exits, PnL cards and halts, takes `/pause` and `/kill`, and can make every entry wait for your tap (`entry.decide: "agent+approve"`).

Still to come, documented here when it lands: a background service that keeps the runner going without a terminal, and the runner filling through the paper desk (https://dexterm.xyz/docs/autotrade#exits-and-wakes) with the exit monitor as its own process.
