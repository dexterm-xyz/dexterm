---
id: docs-strategy-builder-web-what-is-on-the-page
title: Strategy Builder in your browser › What is on the page
kind: docs
page: strategy-builder-web
page_title: Strategy Builder in your browser
heading: What is on the page
anchor: what-is-on-the-page
url: https://dexterm.xyz/docs/strategy-builder-web#what-is-on-the-page
tags:
  - docs
  - strategy-builder-web
  - page
  - strategy
  - builder
  - browser
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/strategy-builder-web.md
date: 2026-10-16
---

**Strategies.** Every strategy you have: the presets, your own and the factory's GENERATED candidates. For each one you see where it is on the ladder (draft, backtested, forward-tested, always-on paper), its rules in plain words, and its numbers exactly as dexterm's own stats return them: the held-out test of a generated candidate, the factory's evidence window (entries, mean per entry, its 95% range, at twice the costs, without the top 3, rug rate), the backtest and its held-out half, the paper forward test and a running paper account. A dash means there is no number; nothing is estimated or rounded up. Different rows come from different windows and samples, so never rank strategies on one column, and treat small samples as meaning nothing. *Cooking now* shows the strategy's paper bags (HELD and SOLD), its last entries and exits and which exit-ladder rungs were hit.

**Builder.** Start from any strategy and change it by form: the entry gates, sizing, the exit ladder (take-profit rungs at a gain or at a market cap, the moonbag that rides after them, the stops) and the caps. A live check validates every change and shows the diff and whether the edit is tighter or looser. Pressing **Create proposal** writes a proposal, the same kind the chat and the `Q` screen use; nothing changes until you press **Apply**. A looser edit asks a second time, like the less-safe popup on the Q screen. Presets and generated strategies are copied into a new strategy of yours. The mode stays paper, and the paper book, the Claude budget and real mode are not editable here. From the builder you can also run a backtest on your recorded history and start or stop a paper forward test.

**Factory.** The strategy factory (https://dexterm.xyz/docs/strategy-factory): its last run, the schedule, today's Claude calls and spend against your caps, the candidates by stage, `lessons.md`, and **Pause**, **Resume**, **Run now** and **Retire**. Each one shows what it would do first and happens only when you press **Confirm**. If you stopped the factory with `FACTORY-STOP` on your terminal, the page shows it and cannot remove it: run `dexterm autotrade factory resume` in your terminal. A pause from the page is a separate pause marker that **Resume** lifts.

**Chat.** The same assistant and tools as the in-app chat, on your own Claude, capped per message. Ask it to list your strategies, explain a candidate, or turn a paper always-on strategy on or off. When it wants to change something it shows a preview card with **Confirm** and **Cancel**, and nothing happens until you press **Confirm**. Token names and feed text are treated as untrusted data, never as instructions.

What the chat cannot do: real mode, arming or promotion; your real-mode limits, the paper book or the daily Claude budget; signing or sending anything; removing `FACTORY-STOP`; applying a change you did not confirm. A strategy edit it suggests, caps included, is a proposal you apply yourself.
