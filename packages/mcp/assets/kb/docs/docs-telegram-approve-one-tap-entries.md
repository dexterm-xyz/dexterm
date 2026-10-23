---
id: docs-telegram-approve-one-tap-entries
title: Telegram (your own bot) › Approve: one-tap entries
kind: docs
page: telegram
page_title: Telegram (your own bot)
heading: Approve: one-tap entries
anchor: approve-one-tap-entries
url: https://dexterm.xyz/docs/telegram#approve-one-tap-entries
tags:
  - docs
  - telegram
  - approve
  - one-tap
  - entries
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

Approvals are on for a strategy whose `entry.decide` is `"agent+approve"`, and for every strategy after `/approvals on` (or `dexterm telegram approvals on`). Your agent still decides and your strategy still clamps the size; the entry then becomes a **proposal** instead of an order:

```
PAPER · PROPOSAL · moonbag v1.0.0 (67fc4c95)
token "SYM" abcd…wxyz
buy $20.00 (2.0% of book) @ 0.0001645 · liq $36.6K · impact ~0.40%
plan: moonbag: cost back at +100%, then a 55% bag trail, out after 7 days, no hard stop
why (the agent's words, unverified): "Fresh pair 34 min old, buyers 1.6x sellers."
expires in 90 s · #k3Jd9aQx
Only these buttons approve. Replies are ignored.
[Approve] [Half size] [Skip]
```

- **No answer is a skip.** A proposal expires after 90 seconds (set 60 to 120 with `dexterm telegram set expiry`), on your computer's clock. There is no auto-approve.
- **[Half size]** only ever halves. **[Skip]** skips.
- **The price is checked again at your tap.** If it moved more than 3 % (never more than the strategy's own slippage), the liquidity fell more than 10 %, or the impact would pass the strategy's cap, the card is re-quoted with fresh numbers and new buttons and you confirm once more. A second move is a skip.
- **Your limits are checked again at your tap**, against the book as it is then: the size can shrink, or the entry is refused.
- **One tap, once.** Every button is bound to a one-time code, the proposal's exact numbers, its expiry, your account and your private chat. A double tap, a second device or an old button gets "Already handled"; a forwarded card tapped by someone else, or in a group, is refused.
- **A kill, a pause or a halt** cancels every open proposal and removes its buttons. If the runner restarts, open proposals expire; they are never brought back.
- **Exits never wait for chat.** Stops, take-profits, trails and rug exits run on their own, and a [Sell] on `/positions` only ever sells.
- At most as many proposals are open at once as the strategy allows sessions; the rest are skipped and counted.

The order then goes through the paper book with a single-use approval for exactly that order (bound to its hash and the proposal): a different order, a different coin, a bigger size or a second use is refused.
