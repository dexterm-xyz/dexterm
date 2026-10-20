---
id: docs-scan-the-read
title: AI scan mode › The read
kind: docs
page: scan
page_title: AI scan mode
heading: The read
anchor: the-read
url: https://dexterm.xyz/docs/scan#the-read
tags:
  - docs
  - scan
  - read
  - mode
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/scan.md
date: 2026-10-16
---

A lock opens the coin exactly as `⏎` would (the same loader, the same fetches that token costs anyway) and starts a chat turn asking for the short read, with the WHY reasons passed as **numbers only, never token text**. Refreshes ask the same warm session what changed. Answers follow the short style (https://dexterm.xyz/docs/analyst#answer-style): call, why, levels, size, one risk.

While the scan is on, the token screen's analyst panel is the scan's **brain view** (on the locked coin, or on any coin while it is still scanning). It shows the scan's own log (on, locks with their score and reasons, refreshes, releases, cancels and blocked actions) with the scan analyst's answer streaming under it, the vetting checklist and data strip for the coin with the app's numbers, and a `SCAN LOG` with `locks · reads · ai usage · observe-only · never trades`. It is the same layout as the agent brain view (https://dexterm.xyz/docs/spectator#the-brain-view-and-the-pnl-chip), with no position block, because the scan never trades. Typing into the analyst, or stopping the scan, brings the normal panel back. While the scan runs and you hold a paper or live position yourself, the PnL chip (https://dexterm.xyz/docs/spectator#the-brain-view-and-the-pnl-chip) shows it on the band under the header of every screen and on the chart popup. It shows the coin the scan locked if you hold it, otherwise the coin on screen, otherwise your first open position. The peak is this session's highest mark, and TP is the ledger's target (`TP not set` when there is none). The scan still never trades.
