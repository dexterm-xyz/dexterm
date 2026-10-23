---
id: docs-autotrade-the-heartbeat
title: Autotrade (paper) › Stopping it › The heartbeat
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: The heartbeat
anchor: the-heartbeat
url: https://dexterm.xyz/docs/autotrade#the-heartbeat
tags:
  - docs
  - autotrade
  - heartbeat
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

- The runner rewrites `runner-status.json` every 10 seconds. If it cannot (a full disk, a removed folder), it takes no new entries until it can again, because the `Q` screen and the exit monitor would see it as gone. With no fresh heartbeat the `Q` screen shows the runner as stale.
- Each position keeps its own `maxHoldMinutes` exit, and a session that dies or times out never holds up an exit.
