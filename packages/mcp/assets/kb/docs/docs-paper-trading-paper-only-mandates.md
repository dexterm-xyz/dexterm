---
id: docs-paper-trading-paper-only-mandates
title: Paper trading and the safety model › Order plans and standing mandates › Paper-only mandates
kind: docs
page: paper-trading
page_title: Paper trading and the safety model
heading: Paper-only mandates
anchor: paper-only-mandates
url: https://dexterm.xyz/docs/paper-trading#paper-only-mandates
tags:
  - docs
  - paper-trading
  - paper-only
  - mandates
  - order
  - plans
  - standing
  - paper
  - trading
  - safety
  - model
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/paper-trading.md
date: 2026-10-16
---

`dexterm mandate draft --paper` drafts a **paper-only** mandate for agent paper trading (https://dexterm.xyz/docs/agents#agent-paper-trading). It has its own, higher paper ceilings ($10,000 total, $2000 per trade, $2000 per coin, $10,000 daily loss, 10% price impact) so an agent can practise at a realistic size, and it still needs your physical keypress to arm. Only the agent paper desk reads it: the plan engine refuses to arm a plan into it, fire a plan under it or run copy trading through it, and every other mandate keeps the ceilings above. The agent still gets a quarter of its per-trade cap, and every fill is priced on a live quote, so a bigger simulated size pays its real price impact.

**Arming** a plan under a mandate is the only step that lets anything fire, and it is a physical gesture: a key held at the terminal on the `O` screen (`a`) or `dexterm plan arm <id> --mandate <id>` on a real TTY, which refuses a pipe or a subprocess. The gesture proof is bound to the plan hash, single-use and expiring, so an edited plan voids every earlier confirmation. Once armed, a monitor fed by the prices the terminal already shows (the screener rows, the watchlist, the open token; never fixture data) fires the entry, each take-profit tranche and the stop **only inside the armed plan and only through the paper executor**, which re-checks the mandate caps and the panic marker on every fill. `dexterm plan amend <id> --size 25 --entry mc-below:280k` edits a **proposed** plan: the edit is a new plan with a new hash, the old proposal is superseded and every earlier confirmation is void, so arming it is a new keypress; an armed plan cannot be edited (cancel it first). Cancel (`c`), revoke (`r`) and panic (`!`, or `dexterm wallet panic`) stop a plan at once; nothing resumes a paused plan without a new keypress.

Two **confirmation tiers** beyond the keypress exist in the model and are off by default: `ptt-held` (push-to-talk held while you speak the confirmation) fires at 0.5× the per-trade cap and `hands-free` at 0.25×, and neither can arm a mandate or a batch. Turning hands-free on is the only "less safe" switch in dexterm: `G` on the `O` screen raises a prompt that says so, it is accepted by a keypress only (a spoken or agent "yes" is refused), it is journaled, it expires after 24 h and `G` again restores the gate.

The **journal** (`~/.dexterm/plans.journal`) is append-only and hash-chained; every proposal, arm, fire, fill, cancel, revoke, gate change and refusal is a row, `dexterm plan journal --verify` recomputes the chain and `--export` dumps it, and it is the source the service recovers from after a crash. The popup is a read-only HUD fed view models only (never a key, a secret or an arm capability); its single write is "cancel this plan", re-validated at the server allow-list and again at the terminal.

What is proven, on fixtures and a fake clock: the north-star plan fills end to end on the paper executor; a replayed price stream fires each leg once; and a compromised-model suite shows that spoken text, agent text, a forged proof, a replayed proof, a widened mandate and an edited plan with an old confirmation all fail to arm, raise a cap, widen a mandate, resume a paused plan, or accept the risk prompt.
