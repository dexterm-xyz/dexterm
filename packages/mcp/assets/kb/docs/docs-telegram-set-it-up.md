---
id: docs-telegram-set-it-up
title: Telegram (your own bot) › Set it up
kind: docs
page: telegram
page_title: Telegram (your own bot)
heading: Set it up
anchor: set-it-up
url: https://dexterm.xyz/docs/telegram#set-it-up
tags:
  - docs
  - telegram
  - set
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

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name, and copy the token it gives you.
2. On your computer, run:

```
dexterm telegram setup
```

Paste the token at the prompt (nothing is shown while you type, and a token passed as an argument is refused, so it never lands in your shell history). dexterm checks it with Telegram and prints the bot's username, then stores the token in your **macOS keychain**, the **system keyring** on Linux (libsecret), or a file only you can read under `~/.dexterm/secrets/` when neither exists. It is never written to a config file, a log, the command line or the environment. Settings live in `~/.dexterm/connectors.json`, which holds no secret.

3. Setup first checks that nobody else is reading your bot (a webhook on it, or another program polling it). If anything is, it refuses to pair. Otherwise it shows a **6-digit pairing code** on your screen, valid for 5 minutes. Open a private chat with your bot from your own account and send `/pair` and the code. Your computer then shows the account the code came from, its **@username and id**, and asks you to confirm it with `y`. Only then is that account in that chat the only one the bot answers. The code travels through Telegram, so this check is what stops someone who has your token: if another program polls the bot while the code is open, pairing stops, and an account you do not recognise gets `n`.

Pair again any time with `dexterm telegram pair` (add `--tiers notify,control` to leave approvals out). Check what is set up with `dexterm telegram status`, and send one test message with `dexterm telegram test`.

4. Start the runner as usual. When a chat is paired, the bot comes up with it:

```
dexterm autotrade run moonbag --paper
```

`--no-telegram` keeps it off for one run.

Turn on Telegram's **two-step verification** for your account. Messages are not end-to-end encrypted: the bot never sends keys, seed phrases, wallet addresses or balances, and it never asks for them. Anything that asks you for those is not dexterm.
