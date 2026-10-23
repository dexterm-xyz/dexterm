---
id: link-a-wallet
title: Link a wallet to show its public key (dexterm wallet)
kind: app-help
screen: all
feature: trading
tags:
  - app-help
  - wallet
  - link
  - unlink
  - phantom
  - connect
  - pubkey
  - panic
  - resume
commands:
  - wallet
flags:
  - --no-live
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

`dexterm wallet link|unlink|status` links a Phantom wallet through a loopback bridge (Phantom signs a MESSAGE, never a transaction): your keys NEVER enter dexterm, only the public key is stored, for display. dexterm holds no key and never signs or sends a transaction; trading in dexterm is paper, and live trading happens in the Telegram trading bot of your choice. `dexterm wallet panic` halts autotrade runs and the paper agent desk at once; only `dexterm wallet resume`, a keypress on a real terminal, clears it. `--no-live` (0.1.6) is accepted and changes nothing. The analyst can never link, unlink or resume.

CLI: `dexterm wallet`.
