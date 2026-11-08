---
id: docs-strategy-factory-the-caps
title: Strategy factory › The caps
kind: docs
page: strategy-factory
page_title: Strategy factory
heading: The caps
anchor: the-caps
url: https://dexterm.xyz/docs/strategy-factory#the-caps
tags:
  - docs
  - strategy-factory
  - caps
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

Every cap stops the run and says which cap it hit; none of them loosens anything else. Defaults, all editable with `dexterm autotrade factory config set KEY VALUE`:

| setting | default | what it limits |
|---|---|---|
| `maxCandidatesPerRun` | 1 | new candidates per run |
| `maxAttemptsPerRun` | 3 | replies tried per run before it gives up |
| `maxActiveGenerated` | 5 | candidates not yet retired; at the cap nothing new is made |
| `maxConcurrentForward` | 1 | forward tests of candidates at once |
| `maxCallsPerRun` / `maxCallsPerDay` | 3 / 3 | calls to your Claude |
| `maxUsdPerCall` / `maxUsdPerRun` / `maxUsdPerDay` | $1 / $2 / $2 | what those calls may cost (the CLI's own spending cap per call; a call that times out or reports no cost counts as the full per-call cap) |
| `maxDiskMb` | 50 | disk for the factory's files |
| `evidenceDays` / `heldOutDays` | 10 / 3 | history the model sees / newest days held back for the test |
| `intervalHours` / `at` | 24 / 04:10 | how often it runs, and when |
| `minFreeMemMb` | 4096 | a scheduled run skips itself under this much available memory (0 = off) |
| `forward.skipHeldOutLosers` | true | retire a candidate whose whole held-out range is below zero instead of forward-testing it |

Values above a hard ceiling (for example more than $20 a day or 3 candidates a run) are refused.
