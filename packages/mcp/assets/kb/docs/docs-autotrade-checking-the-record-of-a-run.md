---
id: docs-autotrade-checking-the-record-of-a-run
title: Autotrade (paper) › Stopping it › Checking the record of a run
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Checking the record of a run
anchor: checking-the-record-of-a-run
url: https://dexterm.xyz/docs/autotrade#checking-the-record-of-a-run
tags:
  - docs
  - autotrade
  - checking
  - record
  - run
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

`dexterm autotrade audit` lists your runs. `dexterm autotrade audit --verify` (all runs, `--last`, or one run id) recomputes each run file's hash chain and checks it against the run's summary, so an edited, missing, reordered or cut-off line is named by its event number. It exits with code 1 when a run does not verify.
