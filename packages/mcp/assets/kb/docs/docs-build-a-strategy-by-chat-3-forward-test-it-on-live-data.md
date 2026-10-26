---
id: docs-build-a-strategy-by-chat-3-forward-test-it-on-live-data
title: Build a strategy by chat › 3. Forward-test it on live data (paper)
kind: docs
page: build-a-strategy-by-chat
page_title: Build a strategy by chat
heading: 3. Forward-test it on live data (paper)
anchor: 3-forward-test-it-on-live-data-paper
url: https://dexterm.xyz/docs/build-a-strategy-by-chat#3-forward-test-it-on-live-data-paper
tags:
  - docs
  - build-a-strategy-by-chat
  - forward-test
  - live
  - data
  - paper
  - build
  - strategy
  - chat
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/build-a-strategy-by-chat.md
date: 2026-10-16
---

A forward test runs the same version on the **live** tape, on paper, with its own bankroll and its own run file, for a window you choose:

```
dexterm autotrade forward start <id> --hours 24          # or --trades 30, or both (whichever comes first)
dexterm autotrade forward status [<id>]
dexterm autotrade forward stop <id>
dexterm autotrade forward report <id> [--json]
```

- It starts in the background and runs next to the always-on service (it does not take the runner's lock). `--foreground` keeps it in your terminal; `--bankroll-usd N` sets its paper bankroll (default: the strategy's own).
- The strategy is frozen at the version it started with. A forward test of a strategy in real mode runs its paper twin: it never sends a signal.
- At the end of its window it sells everything at the next tick (so its numbers are closed numbers), writes its report and records the result. The panic switch stops it like any run.
- The analyst can start and stop one too (`strategy_forward_start`, `strategy_forward_stop`), after a backtest, for at most 72 hours or 200 trades, with the strategy's own bankroll. On the `Q` screen's journey view, `F` starts a 24-hour test and `X` stops it.
- Only a test that ran its **whole window on live data** counts as the forward-tested rung. A test stopped early, run on a replay (`--replay` is a smoke run) or whose process died is shown, never counted.
- A strategy that needs a chat approval for every entry cannot be forward-tested: no tap reaches a forward test. Model sessions of an agent strategy run on your own engine within the strategy's budgets, as in any run.
