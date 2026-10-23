---
id: docs-autotrade-how-a-stop-reaches-the-runner
title: Autotrade (paper) › Stopping it › How a stop reaches the runner
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: How a stop reaches the runner
anchor: how-a-stop-reaches-the-runner
url: https://dexterm.xyz/docs/autotrade#how-a-stop-reaches-the-runner
tags:
  - docs
  - autotrade
  - stop
  - reaches
  - runner
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

- `stop` and `flatten` write a request for the running run to `~/.dexterm/autotrade/control.json`. The runner reads it on every step and shows the halt in its heartbeat file, and the command waits up to 10 seconds (`--wait SEC`) to tell you it did.
- A stop is final for that run: a flatten can follow it, nothing lifts it. To trade again, start a new run.
- A request for an older run never touches a new one, and a control file the runner cannot read counts as a stop.
- `flatten` asks for `y` on a real terminal; `--yes` answers for a script (a flatten only sells).
- The runner reads the panic file on every step, and `dexterm autotrade run` will not start while it is on.
