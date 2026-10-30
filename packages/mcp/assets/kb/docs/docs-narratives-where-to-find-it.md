---
id: docs-narratives-where-to-find-it
title: Memes and narratives (experimental) › Where to find it
kind: docs
page: narratives
page_title: Memes and narratives (experimental)
heading: Where to find it
anchor: where-to-find-it
url: https://dexterm.xyz/docs/narratives#where-to-find-it
tags:
  - docs
  - narratives
  - where
  - find
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

- The `N` screen opens the narrative board. Press `n` to switch between the theme board and the **NARRATIVES**
  heat table. `enter` drills into a narrative's member coins; `esc` goes back to the table.
- The token screen shows a **Narrative** row once the tracker has been built (open `N` then `n` first), for example
  `ZORP · lifecycle: ignition · rank 3 · #2 of 9`.
- `dexterm narratives` prints the heat table. `dexterm narratives detail ID` shows one narrative, `dexterm narratives of
  MINT` shows the narrative of one coin, and `dexterm narratives export --out FILE` writes the JSON
  (`dexterm-narratives/1`) that a strategy tracker page reads. `--at ISO` replays up to a past time.
- MCP tools for your analyst or your own agent: `narratives_top`, `narrative_detail`, `narrative_of` (observe tier,
  read-only). Coin names come back wrapped as untrusted data.
- Watch rules: the field `narrative_rank` and the tags `narrative:ignition` / `narrative:saturated`, so a rule can fire
  "when the coin's narrative ignites".
