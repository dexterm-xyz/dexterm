# dexterm executor reference kit

dexterm holds no key and signs nothing. In real mode a strategy sends a **LIVE TRADE FIRE** signal
(`dexterm-trade-fire/1`) for every buy and sell. **Your own executor** acts on it: a Telegram trading bot you chose,
or any script.

This folder holds three small executors you can wire up in minutes, so you can see the whole path work before
anything can spend money:

| file | channel | how dexterm reaches it |
|---|---|---|
| `webhook-executor.mjs` | webhook | `dexterm autotrade signal channels --webhook http://127.0.0.1:8787/signal` |
| `signal-cmd-executor.mjs` | command hook | `dexterm autotrade signal channels --signal-cmd '["/abs/node","/abs/signal-cmd-executor.mjs","--account","main"]'` |
| `jsonl-tail-executor.mjs` | JSONL stream | `dexterm autotrade signal channels --jsonl on` (add `--jsonl-signed on` for HMAC lines) |

Each one handles every signal the same way:

1. It verifies the HMAC, when you give it the secret file. Without `--secret-file` it acts on unsigned bodies (it says `HMAC NOT checked` when it starts); before you put a real trade into `act()`, run it with `--secret-file` and `--require-hmac`.
2. It checks the account id.
3. It dedupes by nonce. Delivery is at-least-once, so a repeat is normal, and the seen set survives a restart.
4. It ignores anything past `expiresAt` (the TTL).
5. It writes a receipt to dexterm's `autotrade/real/receipts.jsonl` and a heartbeat to `autotrade/real/executor.jsonl`.

**All of them are DRY RUN.** `act()` in `kit.mjs` only logs what it WOULD do, and the receipt says so:
status `rejected`, reason `dry-run: would BUY …`. There is no wallet code, no key and no chain call anywhere in this
kit. Trading for real means replacing `act()` with your own code, or handing the order to your own bot. That is your
code and your wallet, never dexterm's.

## Five minutes, end to end (paper money only)

```sh
# 1. a secret for the HMAC (written to a 0600 file, stored in your keychain, never printed)
dexterm autotrade signal secret generate --out ~/.dexterm-exec.secret

# 2. start the kit's webhook executor (dry run) in another terminal
node webhook-executor.mjs --account main --secret-file ~/.dexterm-exec.secret

# 3. point dexterm at it, then prove the round trip
dexterm autotrade signal channels --webhook http://127.0.0.1:8787/signal
dexterm autotrade signal test          # per channel: delivered, latency, the kit's receipt
dexterm autotrade executor status      # alive · last heartbeat · last receipt · lag
```

`signal test` sends a signal marked `test: true` that names no mint, so there is nothing in it to trade. The kit
receipts it as `rejected` (`test signal: received, never traded`).

## Heartbeats and the silence pause

dexterm counts a heartbeat, a receipt, or an ack on the webhook or command hook as a sign of life. When it hears
nothing for longer than your `executorSilenceMin` limit (placeholder: 15 min), a real run **pauses new buy
signals** and tells you in the run log and on Telegram. Exits keep going out. The kit sends a heartbeat every 60 s
(`--heartbeat-sec`). Your own executor can append the same line, POST it to the run's loopback listener
(`--executor-port`), or run `dexterm autotrade executor heartbeat`:

```json
{"schema":"dexterm-executor-heartbeat/1","at":1761300000000,"executor":"my-bot","accountId":"main","dryRun":false,"lastNonce":42}
```

## Receipts

A receipt is data only. It moves a real position from `unconfirmed` to executed / rejected / failed. With a fill
(`priceUsd`, `sizeSol`, `tokens`, `txSig`), dexterm also measures how far the real fill was from its own paper fill:
slippage, latency, partial fills and rejections. That shows in `dexterm autotrade audit`, `signal status` and
`dexterm autotrade report`.

```json
{"schema":"dexterm-trade-receipt/1","signalId":"<the signal's id>","nonce":42,"accountId":"main","status":"executed","at":1761300001200,"fill":{"priceUsd":0.00123,"sizeSol":0.25,"tokens":40650,"txSig":null},"reason":null,"executor":"my-bot"}
```

See `telegram-bot-recipe.md` for the Telegram trading-bot setup. The bot executes, and dexterm never signs.
