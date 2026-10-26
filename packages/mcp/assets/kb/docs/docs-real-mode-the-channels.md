---
id: docs-real-mode-the-channels
title: Real mode (LIVE TRADE FIRE signals) › The channels
kind: docs
page: real-mode
page_title: Real mode (LIVE TRADE FIRE signals)
heading: The channels
anchor: the-channels
url: https://dexterm.xyz/docs/real-mode#the-channels
tags:
  - docs
  - real-mode
  - channels
  - real
  - mode
  - live
  - trade
  - fire
  - signals
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/real-mode.md
date: 2026-10-16
---

| Channel | How your executor gets it | What counts as delivered |
|---|---|---|
| webhook | `POST` of the line to `http://127.0.0.1`, `localhost` or `[::1]` on any port, or to an `https://` URL of yours. Headers `x-dexterm-signature`, `x-dexterm-nonce`, `idempotency-key`. Redirects are refused. | 2xx; 409 means "already have it". 408, 425, 429, 5xx or no answer is retried; any other 4xx is a rejection. |
| `--signal-cmd` | Your program is started with its argv (an absolute path; no shell, no PATH lookup), the line on stdin, a minimal environment (`DEXTERM_SIGNAL_NONCE`, `DEXTERM_SIGNAL_ID`, `DEXTERM_SIGNAL_SIGNATURE` when a secret is set; nothing else of dexterm's). 10 seconds per call. | exit 0; exit 3 means "already have it"; exit 2 is a rejection; anything else is retried. |
| JSONL stream | One line per signal appended to `~/.dexterm/autotrade/real/signals.jsonl` (0600), or the path you set. Tail it. | the line is written. |
| MCP | The read-only MCP tool `trade_fire_feed` returns the signals after a nonce, plus real mode's state. | the line is written to the feed. |
| Telegram | A `LIVE TRADE FIRE` message to your paired chat, as plain text. For you to read, not for your executor. | Telegram accepted it. |

**Delivery.** A signal is written to the outbox (`~/.dexterm/autotrade/real/outbox.jsonl`) before its fill is booked, so the book never holds anything a signal did not announce. Each channel gets the signals in nonce order, retried with backoff from 1 second up to 30, until it acks, rejects one, or the signal expires (then it is marked expired and never sent late). A restart picks the outbox up where it stopped; nothing is sent twice on purpose, and your executor dedupes the rest by nonce. One process writes the outbox at a time. `dexterm autotrade signal flush` delivers what is pending, and `signal tail` lists the newest signals with their delivery and receipt state.

**The dead-man.** Every signal carries its TTL. A run that ends, halts or is killed sends one final `halted` signal with its outstanding nonces. A runner that dies without one (a crash, a power cut) gets its `halted`, with the reason `runner-lost`, the next time the outbox opens: the next real run or `dexterm autotrade signal flush`.

**A run that ends holding a position.** Ending a real run (its time limit, Ctrl-C, a stop, the kill switch, a halt, a crash) does not sell anything: what is still open is carried. dexterm keeps its real holdings in `~/.dexterm/autotrade/real/held.json`, across runs. You cannot miss them: the run's last lines print the open coins (`REAL POSITIONS STILL OPEN`), the final `halted` signal lists them in `open`, and its Telegram copy says "these positions are still open: manage them in your executor". **When no real run is running, NO signals go out, sells included**: an open position gets no exit from dexterm until the next real run of its strategy, so manage it in your executor. The next real run of the same strategy and account takes them over and their exits keep firing, so a carried coin still gets its sell signal. A carried coin is never bought again while it is held, it counts against the open-position cap, and a coin another strategy holds is not bought. `dexterm autotrade signal held` lists the holdings; if you closed one yourself in your executor, `dexterm autotrade signal release <mint>` (typed confirmation) forgets it.
