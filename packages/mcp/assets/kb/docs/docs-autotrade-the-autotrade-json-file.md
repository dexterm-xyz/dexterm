---
id: docs-autotrade-the-autotrade-json-file
title: Autotrade (paper) › Several strategies at once › The autotrade.json file
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: The autotrade.json file
anchor: the-autotrade-json-file
url: https://dexterm.xyz/docs/autotrade#the-autotrade-json-file
tags:
  - docs
  - autotrade
  - json
  - file
  - several
  - strategies
  - once
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

```json
{
  "schema": "dexterm-autotrade/1",
  "strategies": [
    { "id": "moon-a", "preset": "moonbag", "bankroll": { "usd": 500 } },
    { "id": "fast", "preset": "my-scalp", "bankroll": { "sol": 1 }, "caps": { "modelUsdPerDay": 2, "maxSessions": 1 } },
    { "id": "dip", "file": "/Users/you/strategies/dip.json", "bankroll": { "usd": 200 }, "enabled": false }
  ],
  "global": { "maxConcurrentSessions": 3, "modelUsdPerDay": 15 }
}
```

- **`id`** names the strategy in this run: in its run file, on the Q screen and in every alert. Each id is used once.
- **`preset`** is a shipped preset or one of your own strategies; **`file`** is an absolute path to a strategy file. Give exactly one.
- **`bankroll`** is in USD, or in SOL (converted at the SOL price when the run starts; a replay takes `"solUsd"` or `--sol-usd`). Without it the strategy's own bankroll applies.
- **`caps`** can only tighten a strategy: `maxSessions`, `modelUsdPerDay`, `candidateSessionsPerDay`, `positionSessionsPerDay` and `turnsPerDay`. The stricter of the strategy, these caps, `runner.json` and `global` always applies.
- **`enabled: false`** keeps a strategy in the list without starting it. `dexterm autotrade start <id>` starts it later in the running run.
- **`global`** holds the shared limits. The defaults are 3 sessions open at once, $20 of model spend a day, 96 candidate and 96 position sessions a day, and 4,000 turns a day. The day caps in `runner.json` still apply on top.

Up to 8 strategies (a strategy on several paper accounts counts once per account). Every strategy must check out before anything starts: a typo, an unknown preset or a strategy that is not on paper stops the whole run with each problem named. `--config FILE` reads another file. The file is yours: no tool, chat or agent can add a strategy to it or change a bankroll or a cap.
