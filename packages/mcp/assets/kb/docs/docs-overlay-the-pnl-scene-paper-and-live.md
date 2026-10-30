---
id: docs-overlay-the-pnl-scene-paper-and-live
title: Streamer overlay (OBS) › The PnL scene: PAPER and LIVE
kind: docs
page: overlay
page_title: Streamer overlay (OBS)
heading: The PnL scene: PAPER and LIVE
anchor: the-pnl-scene-paper-and-live
url: https://dexterm.xyz/docs/overlay#the-pnl-scene-paper-and-live
tags:
  - docs
  - overlay
  - pnl
  - scene
  - paper
  - live
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

The card is the PnL card (https://dexterm.xyz/docs/paper-trading#pnl-cards) renderer itself, so its stamp, frame colour, stamp strip, provenance block, data ages and "not financial advice" footer are drawn exactly as on a saved card and cannot be turned off.

- **The agent's trades are PAPER.** An agent can only paper-trade in dexterm, so a card built from the stream is always stamped **PAPER · SIMULATED TRADE · NO REAL FUNDS**, and the scene header says PAPER · SIMULATED. An open position is marked at the newest price the stream carried (converted to SOL at the rate the agent's own fill implies) or, without a later price, at the last fill; the card prints which, and how old the mark is.
- **Your own ledger trades are PAPER or LIVE by wallet mode.** With `--ledger TRADE_ID` the stamp follows the trade's wallet mode: paper is PAPER, devnet is **LIVE · DEVNET** (test funds, not real money) and live is **LIVE · WALLET-SIGNED**, on the card and in the scene header alike. The LIVE note counts the trade's wallet-signed transactions. A real-mode row gets no card (dexterm only modelled that fill; your executor's receipt is the record). The ledger is a local file, read again every 30 seconds.
- **Size is a band and the wallet never shows.** The mint is shortened and transaction signatures are left off the overlay card.
- **A replay is SAMPLE DATA.** With `--replay`, a yellow SAMPLE DATA band sits across the top of the card, above the card's own stamp.
