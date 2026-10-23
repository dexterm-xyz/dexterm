---
id: docs-autotrade-your-strategies
title: Autotrade (paper) › Strategies and presets › Your strategies
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Your strategies
anchor: your-strategies
url: https://dexterm.xyz/docs/autotrade#your-strategies
tags:
  - docs
  - autotrade
  - strategies
  - presets
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

Your strategies live in `~/.dexterm/strategies/<id>.json` (or `$DEXTERM_HOME/strategies`), one file each. Every change is validated first (an invalid file is never written) and appended to `~/.dexterm/strategies/.journal.jsonl` with who made it, the change, and the content hash before and after. Removing a strategy moves it to `.removed/`, never deletes it.

```
dexterm autotrade list                          # your strategies and the presets: version, hash, mode, last backtest
dexterm autotrade new my-swing --from swing     # copy a preset to edit
dexterm autotrade validate my-swing             # every problem, with its path
dexterm autotrade import ./shared.json          # store a strategy file (always as paper)
dexterm autotrade journal my-swing              # the change history
dexterm autotrade remove my-swing
```

A file of yours with a preset's id is used instead of that preset. Importing always sets the mode to paper, whatever the file says.
