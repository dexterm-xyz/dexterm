---
id: docs-strategy-factory
title: Strategy factory
kind: docs
page: strategy-factory
page_title: Strategy factory
url: https://dexterm.xyz/docs/strategy-factory
tags:
  - docs
  - strategy-factory
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

Your own Claude reads how every strategy did and writes one new paper strategy candidate per run, with its reasons. The factory tests it on days the model never saw, queues a paper forward test, and retires it if the forward test fails. Turn strategies on and off by asking the in-app chat. Paper only; candidates are not edges; not financial advice.

The strategy factory automates the loop you would otherwise do by hand: look at how every strategy did, think about why, write a new one, test it honestly, keep what holds up and drop what does not. It runs on a schedule (once a day by default) and makes **at most one new paper strategy candidate per run**.

**Read this first.** A candidate is not an edge. The factory works from the same limited recorded history as everything else, the model can be wrong, and most candidates will fail their tests. Every result is paper and simulated, with modelled fills. Nothing the factory makes trades real money, and nothing it makes is promoted without you.
