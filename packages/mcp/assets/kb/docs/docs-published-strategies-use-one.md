---
id: docs-published-strategies-use-one
title: Published paper strategies › Use one
kind: docs
page: published-strategies
page_title: Published paper strategies
heading: Use one
anchor: use-one
url: https://dexterm.xyz/docs/published-strategies#use-one
tags:
  - docs
  - published-strategies
  - use
  - published
  - paper
  - strategies
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/published-strategies.md
date: 2026-10-16
---

```sh
dexterm autotrade list                                   # the presets, with their version and hash
dexterm autotrade validate ss-s2-old-holders             # the rules, checked, with any warning
dexterm autotrade new my-s2 --from ss-s2-old-holders     # your own copy to edit
dexterm autotrade backtest my-s2                         # replay on your own recorder history (read-only)
```

Presets are read-only and always paper. A copy you make is yours to change; it runs on paper until you arm it yourself. The pool-safety gates need live data, so a replay checks only part of them.
