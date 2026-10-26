---
id: docs-going-real-executor-health
title: Going real, safely › Executor health
kind: docs
page: going-real
page_title: Going real, safely
heading: Executor health
anchor: executor-health
url: https://dexterm.xyz/docs/going-real#executor-health
tags:
  - docs
  - going-real
  - executor
  - health
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

dexterm counts three signs of life from your executor:
- a heartbeat: a `dexterm-executor-heartbeat/1` line in `~/.dexterm/autotrade/real/executor.jsonl`, `dexterm autotrade executor heartbeat`, or a POST to the listener a real run opens with `--executor-port N` (127.0.0.1 only, HMAC required when a secret is set);
- a receipt;
- an ack on the webhook or the command hook.

`dexterm autotrade executor status`, `signal status`, the `Q` screen and Telegram's `/status` show:
- whether your executor is alive, and when it was last heard;
- its last receipt;
- the median lag from a signal to its receipt.

**When it goes quiet** for longer than `executorSilenceMin`, a real run **pauses new buy signals** and tells you in the run log and on Telegram. Exits keep going out. When the executor is heard again, buys resume and you are told. A heartbeat is only evidence of life: it cannot raise a limit, reset the breaker, lift the kill switch or confirm a position.
