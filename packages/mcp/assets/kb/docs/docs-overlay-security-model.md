---
id: docs-overlay-security-model
title: Streamer overlay (OBS) › Security model
kind: docs
page: overlay
page_title: Streamer overlay (OBS)
heading: Security model
anchor: security-model
url: https://dexterm.xyz/docs/overlay#security-model
tags:
  - docs
  - overlay
  - security
  - model
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

The overlay uses the same model as the popup windows (https://dexterm.xyz/docs/popup-chart):

- **Loopback only.** The page server listens on `127.0.0.1` (a random port unless `--port`) and refuses any connection that is not from this machine.
- **Single-use ticket, then a one-time token.** A URL carries a random 32-byte ticket that buys exactly one page load. That page holds a second, one-time token (valid 30 seconds) for its WebSocket. A spent or expired ticket, a ticket for another scene, or a forged token gets an empty 404.
- **Host and Origin checks.** Every request must say `Host: 127.0.0.1:<port>` (so a DNS-rebinding page cannot reach it), and the WebSocket must come from the overlay's own origin. No CORS header is ever sent. Refused probes are printed in the overlay's terminal, without the ticket.
- **No inbound control.** The socket only pushes scene data. Whatever a page sends is counted and dropped, never parsed or acted on; the overlay has nothing it could control.
- **A locked-down page.** Its script and styles are inline under a per-page nonce; the content security policy allows no remote content, no fonts, no frames and no other connections. The page builds its text with `textContent` only (agent and coin text are untrusted), and the only image is the PnL card, sent over the socket.
- **No new network.** The overlay talks to the spectator stream on loopback and reads your ledger file. It fetches nothing from the internet.

The URL is printed in your own terminal so you can paste it; treat it like the popup URLs: it is loopback-only and single-use, but don't post a screenshot of a fresh one.
