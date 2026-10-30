---
id: docs-narratives-limits
title: Memes and narratives (experimental) › Limits
kind: docs
page: narratives
page_title: Memes and narratives (experimental)
heading: Limits
anchor: limits
url: https://dexterm.xyz/docs/narratives#limits
tags:
  - docs
  - narratives
  - limits
  - memes
  - experimental
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/narratives.md
date: 2026-10-16
---

- Name-based: themes that live only on X or Telegram are missed until a coin's name carries them.
- Volume is each source's rolling window at the coin's newest sample; a coin not sampled for 6 h counts as zero.
- Two themes that converge later stay two rows (ids never change).
- The first build of the table reads the last 26 h of recorded history: tens of seconds on a large database (the screen stays live meanwhile).
