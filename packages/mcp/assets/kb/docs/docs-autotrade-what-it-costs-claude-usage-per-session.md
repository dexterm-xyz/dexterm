---
id: docs-autotrade-what-it-costs-claude-usage-per-session
title: Autotrade (paper) › What it costs (Claude usage per session)
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: What it costs (Claude usage per session)
anchor: what-it-costs-claude-usage-per-session
url: https://dexterm.xyz/docs/autotrade#what-it-costs-claude-usage-per-session
tags:
  - docs
  - autotrade
  - costs
  - claude
  - usage
  - per
  - session
  - paper
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/autotrade.md
date: 2026-10-16
---

A session costs Claude usage on your own account, counted from what `claude` reports (`total_cost_usd`; on a subscription that figure is notional, but it is what the runner's caps count). The screening itself uses no model at all: Claude is only called when a coin matches.

**Measured on `sonnet`** (the presets' model) on 2026-10-21: a two-hour run of the `moonbag` preset on live data, with the strategy's own session limits and a $2.75 day cap in `runner.json`:

| in that run | measured |
|---|---|
| coins that matched and got a session | 17 in two hours |
| turns | 24: 16 skips, 5 waits, 1 entry and 2 answers about the position |
| a first look at a coin (one turn) | $0.006 to $0.010 |
| a coin watched for a few updates, then skipped (2 to 3 turns) | $0.012 to $0.018 |
| the one full loop: entry, a cost-recovery event, the close (3 turns) | $0.017 |
| **the whole run** | **$0.17**, well under its cap |

Replies took 2.6 to 8.8 seconds (median 5.3), and the first message was about 1.1 KB. The run file of that run verifies with `dexterm autotrade audit --verify`.

How much a run costs depends mostly on how many coins match your entry rules and how long each one is watched: every update your agent reads is a turn, and a held position adds a turn for each event. Your caps bound it either way: $0.50 per session and $10 a day from the strategy, and the day caps and usage guard in `runner.json`.

**Measured on `haiku`** (`--model haiku`), on one recorded coin replayed at a 1.5-second pace with the `swing` preset and its session budget cut to $0.05:

| session | what happened | turns | cost |
|---|---|---|---|
| 1 | full picture → wait, update → skip | 2 | $0.0009 |
| 2 | full picture → wait, two updates → skip | 3 | $0.0012 |
| 3 | full picture → updates → enter (clamped to $80), two take-profit events → hold, trail exit → acknowledged, session ended | 7 | $0.0023 |

Three sessions, 12 turns, **$0.0044 in all**; on haiku a full candidate → position → close loop was **$0.0023**. Replies took 1.3 to 4.9 seconds (median 2.8).

The run file has each session's cost, and `runner-status.json` today's total.

Paper only. Not financial advice.
