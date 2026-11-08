---
id: docs-strategy-builder-web-the-security-model-in-plain-words
title: Strategy Builder in your browser › The security model in plain words
kind: docs
page: strategy-builder-web
page_title: Strategy Builder in your browser
heading: The security model in plain words
anchor: the-security-model-in-plain-words
url: https://dexterm.xyz/docs/strategy-builder-web#the-security-model-in-plain-words
tags:
  - docs
  - strategy-builder-web
  - security
  - model
  - plain
  - words
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

- **Your machine only.** The server listens on `127.0.0.1` on a free port and refuses requests that do not come from your machine or that name any other host (this blocks DNS-rebinding tricks).
- **One-time link, one session.** The link's ticket works once and only for two minutes. It becomes a cookie the page's own scripts cannot read, and it is never sent to another site.
- **Every change is checked.** A change must come from this page (the origin is checked) and carry the session's own anti-forgery token. Chat, launch, backtest and change requests are rate-limited.
- **No path to real money.** No page action and no chat tool can reach real mode, arming, your real-mode limits, bankrolls, the daily Claude budget, signing or sending. A strategy's own caps and its per-session Claude settings change only through a proposal you apply, and a looser one asks twice. Every change goes through the same paper paths as the terminal: proposals you apply, previews you confirm, paper forward tests.
- **One fixed command.** Watch it cook can only start `dexterm autotrade watch <id>`, with an id that must be one of your strategies right now. Nothing typed into the page becomes part of a command.
- **Nothing secret leaves.** No response carries a key, a wallet secret, your Helius key, a bot token or your environment. Addresses are shortened the same way as the spectator stream, and text from feeds and models is shown as plain text, never as page code. The page loads nothing from the internet.

Paper and simulated; not financial advice.
