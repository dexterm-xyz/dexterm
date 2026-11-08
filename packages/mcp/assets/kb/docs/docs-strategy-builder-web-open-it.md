---
id: docs-strategy-builder-web-open-it
title: Strategy Builder in your browser › Open it
kind: docs
page: strategy-builder-web
page_title: Strategy Builder in your browser
heading: Open it
anchor: open-it
url: https://dexterm.xyz/docs/strategy-builder-web#open-it
tags:
  - docs
  - strategy-builder-web
  - open
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

```
dexterm autotrade web                # opens your browser
dexterm strategies web               # the same command
dexterm autotrade web --no-open      # print the link, do not open a browser
```

The command prints a link like `http://127.0.0.1:<port>/?t=…`. That link works **once**: opening it starts your session (a cookie only this page can read) and the address bar drops the one-time part. To open it again, or in another browser, press `n` in the terminal for a fresh link. A fresh link ends the old session, so only one browser is signed in at a time. Press `q` to stop the server.
