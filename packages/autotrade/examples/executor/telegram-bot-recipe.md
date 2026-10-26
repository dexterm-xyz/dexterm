# Recipe: a Telegram trading bot as your executor

Many people already trade memecoins through a Telegram trading bot. That bot holds the wallet and signs the swaps.
dexterm can drive the decision side, but it can never be the bot and never holds the bot's key.

## Why the Telegram copy alone is not enough

dexterm's Telegram copy of each signal goes to **your** chat, for you to read. A bot cannot read another bot's
messages, so your trading bot never sees that copy. Something on your side has to hand each signal to the bot.

## The shape that works

```
dexterm (real mode) --signal--> your small relay (one of the kit executors) --order--> your trading bot
                     <--receipt--                                          <--fill--
```

1. Start from one of the kit executors, for example `webhook-executor.mjs`. It already verifies the HMAC, dedupes
   by nonce, honours the TTL, writes receipts and sends heartbeats.
2. Replace `act()` in `kit.mjs` with the call your bot offers to accounts that automate it. Depending on the bot
   that is an HTTP API, a CLI, or a message your own user account sends to it through a Telegram client library.
   Use only what the bot documents and allows. That code, its credentials and the wallet are yours; keep them out
   of dexterm's folders.
3. When the bot answers, write the receipt with the real fill: `status: "executed"` plus `priceUsd`, `sizeSol`,
   `tokens` and `txSig`, or `rejected` / `failed` with a reason. dexterm then shows how far the real fills were
   from paper.
4. Keep the relay's heartbeat running. If the relay or the bot goes quiet longer than your `executorSilenceMin`,
   dexterm pauses new buy signals and tells you.

## Rules the relay must keep (the kit does)

- It acts only on signals for its own `accountId`.
- It never acts after `expiresAt`, and it never retries a stale order on its own.
- It dedupes by `nonce` and `id`, because the same signal can arrive twice.
- It treats `type: "test"` as a test: there is never an order.
- On `type: "halted"`, it may cancel the `outstanding` nonces that are still open on its side. `open` lists what
  dexterm still counts as held.
- It sizes from its own wallet. `sizeSol` is what dexterm's limits allowed, and `sellFraction` applies to what the
  bot really holds.

## Before any real money

- Run the relay in dry run first. `dexterm autotrade signal test` must show every channel delivered and the relay's
  receipt.
- Set your own limits (`dexterm autotrade limits set …`). The defaults are placeholders: 0.25 SOL per trade, 1 SOL
  a day, 20 buys, 3 open, stop at -0.5 SOL a day.
- Keep `dexterm autotrade signal kill` at hand. It stops every signal except one final `halted`.
