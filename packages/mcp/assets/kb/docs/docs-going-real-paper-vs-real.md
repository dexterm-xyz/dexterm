---
id: docs-going-real-paper-vs-real
title: Going real, safely › Paper vs real
kind: docs
page: going-real
page_title: Going real, safely
heading: Paper vs real
anchor: paper-vs-real
url: https://dexterm.xyz/docs/going-real#paper-vs-real
tags:
  - docs
  - going-real
  - paper
  - real
  - going
  - safely
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/going-real.md
date: 2026-10-16
---

When your executor's receipts carry fills (`priceUsd`, `sizeSol`, `tokens`), dexterm compares each one with its own paper fill for that signal:
- slippage, positive when the real fill was worse than paper;
- latency from the signal to its receipt;
- partial fills;
- rejections and failures, with their reasons.

This shows in `dexterm autotrade signal status`, `dexterm autotrade audit`, every run file's receipt rows and the digest. Use it to calibrate: if real fills land 4% worse than paper, the backtests and forward tests are 4% optimistic per trade. With few receipts the numbers say little, and the report says so.
