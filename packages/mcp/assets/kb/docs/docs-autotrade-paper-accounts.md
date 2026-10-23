---
id: docs-autotrade-paper-accounts
title: Autotrade (paper) › Several strategies at once › Paper accounts
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Paper accounts
anchor: paper-accounts
url: https://dexterm.xyz/docs/autotrade#paper-accounts
tags:
  - docs
  - autotrade
  - paper
  - accounts
  - several
  - strategies
  - once
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/autotrade.md
date: 2026-10-16
---

A paper account is one simulated wallet that several strategies trade from together. List the accounts in `autotrade.json` and point a strategy at one with `account` instead of giving it a bankroll:

```json
{
  "schema": "dexterm-autotrade/1",
  "accounts": [
    { "id": "main", "bankroll": { "usd": 1000 } },
    { "id": "yolo", "bankroll": { "sol": 1 } }
  ],
  "strategies": [
    { "id": "moon", "preset": "moonbag", "account": "main" },
    { "id": "scalp", "preset": "scalp", "account": ["main", "yolo"] },
    { "id": "solo", "preset": "my-scalp", "bankroll": { "usd": 200 } }
  ]
}
```

- **Many strategies, one wallet.** `moon` and `scalp` both trade from `main`'s cash: a buy by one leaves less for the other, a sale pays back into the same account, and every size is a share of the whole account (cash plus what is held). An order is checked against the cash again at the fill, so two strategies can never spend the same dollars.
- **One strategy, many wallets.** A list of accounts runs the same strategy once per account, here as `scalp-main` and `scalp-yolo`. Each one is its own strategy in the run: its own run file, positions, loss limits, sessions and spend budget, and `dexterm autotrade stop --strategy scalp-yolo` stops only that one.
- **What stays per strategy:** its positions, its share of the money at risk (`maxExposurePct` counts its own positions against the account), its loss streak and cooldowns, its per-coin rules, its entries per day and its model budget. Its drawdown limit reads the account: when the account falls far enough, each strategy on it stops entering at its own limit.
- **Mixing is fine.** Strategies with their own `bankroll` run next to strategies on accounts. A strategy on an account takes no `bankroll` of its own, and an account it names must be in `accounts`; anything else stops the run before it starts, with the problem named.

Accounts live for the run: each starts at its `bankroll` when the run starts (a SOL balance at the SOL price, or `"solUsd"` / `--sol-usd` in a replay), and a strategy you `start` again later joins the same account. Up to 8 accounts. Paper only: an account is simulated cash and never backs a live strategy.
