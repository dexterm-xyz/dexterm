---
id: docs-strategy-factory-where-it-should-run
title: Strategy factory › Where it should run
kind: docs
page: strategy-factory
page_title: Strategy factory
heading: Where it should run
anchor: where-it-should-run
url: https://dexterm.xyz/docs/strategy-factory#where-it-should-run
tags:
  - docs
  - strategy-factory
  - where
  - should
  - run
  - strategy
  - factory
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/strategy-factory.md
date: 2026-10-16
---

On the machine that runs the recorder (its history is what the factory reads; it opens it read-only). A run on ten days of history reads every coin of those days into memory and replays each strategy twice: expect a few minutes of one CPU core and up to about 2 GB of memory, once a day, at low priority. Do not schedule it on a machine that is streaming or recording video at the same time.
