---
id: docs-build-a-strategy-by-chat-1-ask-for-a-strategy
title: Build a strategy by chat › 1. Ask for a strategy
kind: docs
page: build-a-strategy-by-chat
page_title: Build a strategy by chat
heading: 1. Ask for a strategy
anchor: 1-ask-for-a-strategy
url: https://dexterm.xyz/docs/build-a-strategy-by-chat#1-ask-for-a-strategy
tags:
  - docs
  - build-a-strategy-by-chat
  - ask
  - strategy
  - build
  - chat
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/build-a-strategy-by-chat.md
date: 2026-10-16
---

Open the analyst and say what you want, for example: "build me a strategy that buys young pairs on a 5-minute push, takes the cost back at 2x and lets the rest ride". The analyst works only through typed tools: it reads the presets, then **proposes** a new strategy (a copy of a preset with its changes) and any edits after that. Each proposal arrives on the `Q` screen as a card with the fields that change, the validation result and TIGHTER, NEUTRAL or LOOSER; `o` opens it, `y` applies it (a looser edit needs a second `y`), `n` dismisses it. Nothing exists until you apply it, and a new strategy always starts on paper. Your mode, bankroll, model budget and exit-liquidity floor stay yours: the analyst cannot change them. See changing a strategy by chat (https://dexterm.xyz/docs/autotrade#change-a-strategy-by-chat).
