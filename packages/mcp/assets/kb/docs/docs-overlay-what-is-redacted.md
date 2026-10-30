---
id: docs-overlay-what-is-redacted
title: Streamer overlay (OBS) › What is redacted
kind: docs
page: overlay
page_title: Streamer overlay (OBS)
heading: What is redacted
anchor: what-is-redacted
url: https://dexterm.xyz/docs/overlay#what-is-redacted
tags:
  - docs
  - overlay
  - redacted
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

Redaction is always on, and the overlay applies it itself, whatever its source already did:

- Every wallet or mint address becomes its first and last four characters (`Fixt…AAAA`), in every field: tool names, summaries, agent names, LARP evidence, signal text.
- Key material (long base58 or hex runs) becomes `[key]`.
- Anything the spectator stream marks sensitive is shown as `[sensitive]`, and sensitive-named fields are dropped before they reach a scene.
- A coin, fill or ticket whose mint is not in the shortened shape is dropped, not shown.
