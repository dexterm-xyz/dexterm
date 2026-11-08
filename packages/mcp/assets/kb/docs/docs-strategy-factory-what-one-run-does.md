---
id: docs-strategy-factory-what-one-run-does
title: Strategy factory › What one run does
kind: docs
page: strategy-factory
page_title: Strategy factory
heading: What one run does
anchor: what-one-run-does
url: https://dexterm.xyz/docs/strategy-factory#what-one-run-does
tags:
  - docs
  - strategy-factory
  - run
  - does
  - strategy
  - factory
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/strategy-factory.md
date: 2026-10-16
---

1. **Gathers the evidence** (read only). For every strategy you have (the presets, your own and earlier candidates): on your recorded history, each candidate coin entered at a fixed $20, the number of entries, the mean result per entry after modelled costs, its 95% range, the mean if costs were twice as high, the mean without the three best entries, and the rug rate. It adds each strategy's forward-test result and paper ledger if it has one, and the factory's own lessons so far (`lessons.md`: what failed, what held up).
2. **Asks your own Claude** (the same `claude` command the analyst uses, no tools, a hard spending cap per call) for one new strategy: changes to the entry rules and exits of one strategy, optionally borrowing from others, with a written reason for every rule, what it expects to fail on and what it changes versus its parents. It may also suggest retiring a bad strategy; that stays a suggestion.
3. **Checks the reply** before anything is saved:
   - every number it cites must be in the evidence it was given, with the same value; a reply with an invented number is rejected;
   - it may change entry rules and exits only: never sizing, risk limits, caps, the bankroll, the fill model, the mode, or a safety check's on/off switch;
   - it must validate (`dexterm autotrade validate`), and its rules must not already exist (same rules hash) or be a near copy of an existing strategy.
   A rejected reply is logged with its reasons; the next attempt is told why. The number of attempts per run is capped.
4. **Tests it on days the model never saw.** The newest days (3 by default) are held back from the evidence. The candidate is backtested on them once: entries, mean per entry, 95% range, at 2x costs, without the top 3, rug rate, and a plain verdict. That result is written next to the strategy (`generated/<id>/report.json` and `rationale.md`) and counts as its backtest on the ladder (https://dexterm.xyz/docs/build-a-strategy-by-chat#the-ladder).
5. **Queues a paper forward test** (live data, its own paper bankroll, 72 hours or 200 closed trades, whichever comes first). Only one runs at a time by default. A candidate whose whole held-out 95% range is below zero (at least 20 entries) cannot pass the forward bar on that evidence: it is **retired at once** (kept on disk, with the reason) and does not take a forward slot. `factory config set forward.skipHeldOutLosers false` queues it anyway.
6. **Judges finished forward tests** on the next run. A candidate whose forward test lost, ended early, or made fewer than 10 closed trades is **retired**: kept on disk with its report and the reason, never deleted. One that ended above zero is marked *forward-passed*, which still only means "a candidate": the bar for calling any strategy good (at least 100 closed forward entries, the whole 95% range above zero, still above zero at twice the costs) is far higher, and promotion to always-on is always your decision.

Generated strategies are always paper and decide mechanically (no model calls while they run), so the backtest and the forward test measure the same thing. They are tagged **GENERATED** on the `Q` screen and everywhere else.
