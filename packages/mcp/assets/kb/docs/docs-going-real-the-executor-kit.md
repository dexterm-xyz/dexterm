---
id: docs-going-real-the-executor-kit
title: Going real, safely › The executor kit
kind: docs
page: going-real
page_title: Going real, safely
heading: The executor kit
anchor: the-executor-kit
url: https://dexterm.xyz/docs/going-real#the-executor-kit
tags:
  - docs
  - going-real
  - executor
  - kit
  - going
  - real
  - safely
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/going-real.md
date: 2026-10-16
---

`dexterm autotrade executor kit --out ~/my-executor` copies three small executors, plain Node with no dependencies:

| file | channel | point dexterm at it |
|---|---|---|
| `webhook-executor.mjs` | webhook (127.0.0.1 only) | `dexterm autotrade signal channels --webhook http://127.0.0.1:8787/signal` |
| `signal-cmd-executor.mjs` | command hook | `dexterm autotrade signal channels --signal-cmd '["/abs/path/node","/abs/path/signal-cmd-executor.mjs","--account","main"]'` |
| `jsonl-tail-executor.mjs` | the JSONL stream | `dexterm autotrade signal channels --jsonl on --jsonl-signed on` |

Each one handles every signal the same way:

1. It checks the HMAC (`--secret-file`, the file `dexterm autotrade signal secret generate --out FILE` writes).
2. It checks the account.
3. It ignores a repeat by nonce. The seen set survives a restart.
4. It ignores anything past its expiry.
5. It writes a receipt and sends a heartbeat.

They are **dry run**: they log what they would do, and their receipts say so. There is no wallet code, no key and no chain call in the kit. To trade, you replace one function (`act()` in `kit.mjs`) with your own code, or hand the order to the Telegram trading bot you chose. The kit's `telegram-bot-recipe.md` explains that set-up: a bot cannot read another bot's messages, so a small relay of yours hands each signal to the bot.

`--jsonl-signed on` writes each stream line as an envelope carrying the same HMAC as the webhook, so a stream reader can check it too.

**Prove it end to end:** `dexterm autotrade signal test` sends a signal marked `test: true` that names no coin, so there is nothing in it to trade. For each channel it shows whether the signal was delivered and how long that took, then your executor's receipt (`--wait SEC`, `--json`). The Telegram copy is for you, so it waits for the next run.
