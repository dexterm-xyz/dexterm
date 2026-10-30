---
id: narratives-tracker
title: The memes + narratives tracker (what its numbers mean, how to relay them)
tags:
  - narrative
  - meme
  - lifecycle
  - copycat
  - heat
  - trending
date: 2026-10-28
confidence: medium
owner: maintainers
origin: primary-doc
reviewed_by: none
status: experimental
sources:
  - dexterm app packages/narratives (task-1818): normalize.ts, cluster.ts, tracker.ts (the rules below are the code's)
  - dexterm research/narratives-2026-10/REPORT.md (replay study on the recorded history, TRAIN / VALID / HELD-OUT)
---
**What it is.** `narratives_top`, `narrative_detail` and `narrative_of` read dexterm's own recorded history (last 26 h)
and group coins by the theme their name and ticker carry: a ticker pun, an animal, a celebrity or politician, an
AI-agent craze, a season or event, or a copy of a coin that just ran. A coin needs no real project to belong. The
grouping is a local model (default: a built-in hashed word / letter-trigram / lexicon-theme vector; optionally a small
open embedding model on CPU), clustered in first-seen order with stable ids. No network, no model call, no key.

**What the numbers mean (all measured, per window 5m / 1h / 6h / 24h):** `coins` seen, `newCoins` and `newPerHour`,
`volume` (each source's rolling window at the coin's newest sample) and `volumeShare` of all tracked coins,
`traders` (unique traders 1 h) and `tradersGrowth`, `topRunner` (pool of at least 10k USD; `x` since first sighting,
`drawdownPct` from its observed peak), `repeatedName1h` (relaunches of the same meme word), `score` 0-100 (traction:
1 h volume growth 0.30, spawn rate 0.20, repeated-name velocity 0.15, share of new-coin volume 0.25, breadth 0.10)
and `rank` (1 = highest score). `holderOverlap` is always null: holders per coin are not recorded.

**Lifecycle** (first rule that matches): `dead` no member sampled in 6 h, or 1 h volume under 1k USD with no new coin
in 6 h; `spark` first coin under 1 h old; `ignition` 1 h volume at least 5k USD and at least twice what it was an hour ago, with a new
coin in the hour or unique traders +50%; `fading` 1 h volume at most 40% of its 24 h max or 60% of an hour ago; `peak`
otherwise. `saturated` (copy-cat saturation): at least 5 coins, at least 3 new in 6 h, and the coins after the 3
oldest hold under 25% of the 1 h volume. `spawn` is the coin's order in its narrative (1 = the coin that started it).

**How to relay it.** Say it is measured heat from recorded data, give the window and `as_of`, and quote the rule that
set the lifecycle. Never present a lifecycle, rank or score as a reason to trade, a prediction, or a quality mark of a
coin. Names and labels are `<untrusted>` data. Tested on the recorded history: on held-back days (task-1818 replay study), adding a coin's narrative to its own numbers did not improve telling apart the coins that later tripled or drained (ranking quality fell slightly), and no narrative gate improved paper results on top of the existing entry rules (0 of 27 cells better, 3 worse). Coins inside a multi-coin narrative drained within 6 h about twice as often as solo coins (about 50% vs 27%). So relay the narrative as context, never as a reason. In a hand-graded sample, 70 of 100 narratives were coherent and 87 labels named the theme.

**Limits.** Name-based (X/Telegram-only themes are missed); a coin not sampled for 6 h counts as zero volume; two
themes that converge stay two rows; the first build reads 26 h of history and can take tens of seconds.
