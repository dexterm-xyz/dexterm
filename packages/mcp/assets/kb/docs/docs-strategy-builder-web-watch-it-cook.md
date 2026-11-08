---
id: docs-strategy-builder-web-watch-it-cook
title: Strategy Builder in your browser › Watch it cook
kind: docs
page: strategy-builder-web
page_title: Strategy Builder in your browser
heading: Watch it cook
anchor: watch-it-cook
url: https://dexterm.xyz/docs/strategy-builder-web#watch-it-cook
tags:
  - docs
  - strategy-builder-web
  - watch
  - cook
  - strategy
  - builder
  - browser
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/strategy-builder-web.md
date: 2026-10-16
---

The **Watch it cook** button opens a new terminal window running dexterm in watch mode on the strategy you picked:

```
dexterm autotrade watch <id> --open-overlay
```

The window shows the strategy overlay: its rules, its open paper bags (HELD) and the last closed ones (SOLD), its entries and exits as the run ledgers record them, its paper equity and the ladder rungs hit. The same view opens in your browser as the overlay `strategy` scene, which you can also add to OBS as a browser source (see overlay (https://dexterm.xyz/docs/overlay)). If a spectator (https://dexterm.xyz/docs/spectator) session is already running, the window attaches to it instead of starting a second one, and the page says so.

The watch window only observes: it cannot arm, size, sign, send, start or stop anything, or change a cap. Press `q` to close it, or `n` for a fresh overlay link.

Which terminal opens: on macOS, Terminal; on Linux, the first of `x-terminal-emulator`, `gnome-terminal`, `kitty`, `konsole` or `xterm`; on Windows, Windows Terminal, or a command window. If none can be opened, the page shows the exact command with a **Copy** button so you can run it yourself.
