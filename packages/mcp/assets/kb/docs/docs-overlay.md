---
id: docs-overlay
title: Streamer overlay (OBS)
kind: docs
page: overlay
page_title: Streamer overlay (OBS)
url: https://dexterm.xyz/docs/overlay
tags:
  - docs
  - overlay
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

Put an agent session on your stream. dexterm overlay serves three transparent scenes for an OBS Browser source (agent activity, the coin card, the PAPER or LIVE PnL card) on 127.0.0.1, fed by the read-only spectator stream or a saved replay. Covers the OBS setup step by step, the three themes, what is redacted, the security model, the SAMPLE DATA tag and the limits.

`dexterm overlay` turns the spectator view (https://dexterm.xyz/docs/spectator) into scenes you can drop into OBS as a **Browser source**: the agent's recent calls, the coin it is on, and its PnL card, over a transparent background. It watches; it never acts. Nothing on an overlay page can pause, trade, arm, size, sign or raise a cap, and the page sends nothing back to dexterm.
