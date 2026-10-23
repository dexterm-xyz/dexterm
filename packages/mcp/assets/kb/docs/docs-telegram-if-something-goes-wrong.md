---
id: docs-telegram-if-something-goes-wrong
title: Telegram (your own bot) › If something goes wrong
kind: docs
page: telegram
page_title: Telegram (your own bot)
heading: If something goes wrong
anchor: if-something-goes-wrong
url: https://dexterm.xyz/docs/telegram#if-something-goes-wrong
tags:
  - docs
  - telegram
  - something
  - goes
  - wrong
  - own
  - bot
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/telegram.md
date: 2026-10-16
---

- **Telegram is down, or a message cannot be sent:** the proposal is a skip. Notifications retry. The runner never waits on chat, and your exits are unaffected.
- **Someone else uses your token** (a webhook appears on the bot, or another program polls it): the bot stops every approval, you are warned on your computer, and every local control keeps working (`dexterm autotrade stop`, the AUTOTRADE screen, `dexterm wallet panic`). Messages from accounts that are not paired get no answer; five in an hour raise a "possible token leak" warning on your computer.
- **Revoke it:** `dexterm telegram revoke` removes the token from your computer and forgets every paired chat. If the token may have leaked, also send `/revoke` to @BotFather for that bot and run setup again.
