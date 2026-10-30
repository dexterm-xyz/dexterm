---
id: narratives-tracker
title: Track memes and narratives (dexterm narratives, experimental)
kind: app-help
screen: narrative
feature: narratives
tags:
  - app-help
  - narratives
  - narrative
  - memes
  - meme
  - copycat
  - lifecycle
  - ignition
  - heat
  - saturated
  - experimental
keys:
  - n
  - enter
actions:
  - narrative.view
  - narrative.drill
commands:
  - narratives
tools:
  - narratives_top
  - narrative_detail
  - narrative_of
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

EXPERIMENTAL. The narratives tracker groups coins by the theme their name and ticker carry (ticker puns, animals, celebrities, AI agents, seasonal events, copy-cats of a runner) and measures each theme per window: coins, new-coin rate, volume share, unique-trader growth, top runner and drawdown, a lifecycle state (spark / ignition / peak / fading / dead, with the rule that set it) and a copy-cat saturation flag. On the N screen, n flips the board into the NARRATIVES table (the first switch reads the last 26 h of recorded history and takes tens of seconds), enter to see a narrative's coins in spawn order, esc to go back. `dexterm narratives [top|detail ID|of MINT|export]` prints the same from the recorder; the analyst uses narratives_top, narrative_detail and narrative_of. Rules can use narrative_rank, narrative_score and the tags narrative:ignition / narrative:saturated. Keyless and local; measured heat, not advice.

Keys: `n` (narrative), `⏎` (narrative). CLI: `dexterm narratives`.
