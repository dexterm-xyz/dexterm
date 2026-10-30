---
id: docs-overlay-limits
title: Streamer overlay (OBS) › Limits
kind: docs
page: overlay
page_title: Streamer overlay (OBS)
heading: Limits
anchor: limits
url: https://dexterm.xyz/docs/overlay#limits
tags:
  - docs
  - overlay
  - limits
  - streamer
  - obs
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/overlay.md
date: 2026-10-16
---

- **The scenes show what the agent did.** If the agent never reads holders, the holder bar stays "not read yet"; if it never runs a LARP check, there is no LARP line. Live signals appear only while your terminal follows the agent (`--spectate-mcp`) and has that coin's data.
- **One coin at a time.** The coin card follows the coin the agent touched last; the PnL card follows the agent's newest paper fill.
- **A reload needs a fresh URL** (see the OBS steps). This is the single-use ticket working as designed.
- **The stream starts with the last 200 events** when the overlay connects, then follows live.
- **Not financial advice.** The verdict, LARP evidence and signals are risk information, never a recommendation; paper results are simulated.
