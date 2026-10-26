---
id: docs-build-a-strategy-by-chat-the-ladder
title: Build a strategy by chat › The ladder
kind: docs
page: build-a-strategy-by-chat
page_title: Build a strategy by chat
heading: The ladder
anchor: the-ladder
url: https://dexterm.xyz/docs/build-a-strategy-by-chat#the-ladder
tags:
  - docs
  - build-a-strategy-by-chat
  - ladder
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

A strategy you build climbs one ladder, one rung at a time:

**draft → backtested → forward-tested → always-on (paper) → real**

| rung | what it needs | who does it |
|---|---|---|
| draft | a strategy that validates | the analyst proposes it, you apply it with a key |
| backtested | a backtest on your recorded history, with the held-out split | you or the analyst |
| forward-tested | a forward test that ran its whole window on live data, on paper | you or the analyst starts it; it runs by itself |
| always-on | a member of `autotrade.json`, run by the always-on service (https://dexterm.xyz/docs/autotrade#the-always-on-service) on paper | the analyst can propose it; only you apply it |
| real | real mode armed on your own terminal, with caps you set, above the evidence floor: a completed forward test with at least 10 closed paper trades and a backtest | only you, with a typed phrase (real mode (https://dexterm.xyz/docs/real-mode)) |

Every rung counts evidence measured on the strategy's **exact rules**. Renaming it, rewording its description or arming it for real keeps its evidence; changing any rule (an entry filter, a size, an exit, a limit) starts the ladder again from draft. No rung can be skipped, and `dexterm autotrade journey <id>` (or `J` on the `Q` screen) always shows where a strategy stands and what the next rung needs.
