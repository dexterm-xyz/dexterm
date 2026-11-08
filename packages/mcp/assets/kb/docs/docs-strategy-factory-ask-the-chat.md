---
id: docs-strategy-factory-ask-the-chat
title: Strategy factory › Ask the chat
kind: docs
page: strategy-factory
page_title: Strategy factory
heading: Ask the chat
anchor: ask-the-chat
url: https://dexterm.xyz/docs/strategy-factory#ask-the-chat
tags:
  - docs
  - strategy-factory
  - ask
  - chat
  - strategy
  - factory
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/strategy-factory.md
date: 2026-10-16
---

In the in-app chat you can say, in plain words:

- "list my strategies", "which are on?", "how is ss-s2 doing?"
- "show me the newest generated strategy and why it was made"
- "turn ss-s2 off", "turn it back on"
- "retire gen-1105-a3f2"
- "pause the factory", "resume the factory", "run the factory now"

Every change is shown to you first, for example: *turn ss-s2 off: its always-on PAPER entry is disabled, and the running one takes no new paper entries from its next tick; open bags are kept and keep their exits.* It happens only when **you** reply "yes" (or the code it shows) in your next message; "no" cancels. The model cannot confirm for you, and a change offered more than 10 minutes ago expires.

**On and off** is the paper always-on switch of a strategy that is already on your always-on list (`autotrade.json`). A strategy that is not on the list gets there only through the promotion flow (https://dexterm.xyz/docs/build-a-strategy-by-chat#the-ladder), which you apply with a key.

**What the chat cannot do:** switch anything to real mode, arm it, change a cap, a limit or a bankroll, or anything that signs or sends. Ask for it and the chat says no and points you to `dexterm autotrade promote <id> --to real` and `dexterm autotrade signal arm <id>` on your own terminal (real mode (https://dexterm.xyz/docs/real-mode)). The Telegram bot can show the same read-only views; it cannot change anything.
