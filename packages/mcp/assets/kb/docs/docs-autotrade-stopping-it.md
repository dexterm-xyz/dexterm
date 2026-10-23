---
id: docs-autotrade-stopping-it
title: Autotrade (paper) › Stopping it
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Stopping it
anchor: stopping-it
url: https://dexterm.xyz/docs/autotrade#stopping-it
tags:
  - docs
  - autotrade
  - stopping
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

Three switches, from soft to hard. You use them; your agent cannot. A session has no tools, and its answer has no stop, resume or flatten in it.

| switch | what stops | what keeps running | after it |
|---|---|---|---|
| `dexterm autotrade stop`, or `!` on the `Q` screen | new entries; every session closes; orders not yet filled are dropped | the mechanical exits on what you hold | the runner ends once nothing is held |
| `dexterm autotrade flatten`, or `f` then `y` on the `Q` screen | the same, then every paper position sells at its next tick | a coin that cannot sell (a pulled pool) is retried every tick | the runner ends once nothing is held |
| `dexterm wallet panic` | the runner halts on its next step, as in a stop; every paper desk refuses too | the runner's mechanical exits | nothing starts again until `dexterm wallet resume`, a keypress on a real terminal |

`p` on the `Q` screen pauses new entries, and `p` again resumes them; open positions keep their exits either way.

With several strategies at once (https://dexterm.xyz/docs/autotrade#several-strategies-at-once), these switches act on every strategy, and `--strategy ID` on `stop`, `flatten`, `pause` and `resume` acts on one. An agent you connect over MCP can stop or pause one strategy you listed there, never all of them and never the panic.
