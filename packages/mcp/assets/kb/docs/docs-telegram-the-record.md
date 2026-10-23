---
id: docs-telegram-the-record
title: Telegram (your own bot) › The record
kind: docs
page: telegram
page_title: Telegram (your own bot)
heading: The record
anchor: the-record
url: https://dexterm.xyz/docs/telegram#the-record
tags:
  - docs
  - telegram
  - record
  - own
  - bot
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/telegram.md
date: 2026-10-16
---

Every inbound update (the sender, the chat, the command or button; free text only as a length and a hash), every message sent, every proposal state and every check of a tap is written to `~/.dexterm/autotrade/chat/<day>.jsonl`, hash-chained like the run files. The token, raw one-time codes and balances are never written. `dexterm telegram audit --verify` recomputes each day's chain and names the first edited, missing or reordered line. The run file records each approval request, the answer and the fill it led to, and anchors the chat record (its day file, head and length) when a run starts and ends. The check compares every anchor, so a day file that was cut short, deleted or rewritten after a run anchored it does not verify. Lines written after the last run ended are not anchored yet.
