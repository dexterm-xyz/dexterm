---
id: docs-narratives-what-is-measured
title: Memes and narratives (experimental) › What is measured
kind: docs
page: narratives
page_title: Memes and narratives (experimental)
heading: What is measured
anchor: what-is-measured
url: https://dexterm.xyz/docs/narratives#what-is-measured
tags:
  - docs
  - narratives
  - measured
  - memes
  - experimental
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/narratives.md
date: 2026-10-16
---

Per narrative and window (5 m, 1 h, 6 h, 24 h): coins seen, new coins and the new-coin rate, the narrative's share of all
tracked volume, unique traders (1 h, Jupiter) and their growth, the top runner (sellable pool of at least 10k USD) and its drawdown
from its peak, how often the same meme word was relaunched in the last hour, and a 0-100 **traction score** (1 h volume
growth, spawn rate, repeated-name velocity, share of new-coin volume, breadth). Rank 1 is the highest score.
**Cross-coin holder overlap is not recorded, so it is not part of the score** (it shows as null, never estimated).

**Lifecycle**, first rule that matches:

| state | rule |
|---|---|
| dead | no member sampled in 6 h, or 1 h volume under 1k USD with no new coin in 6 h |
| spark | the first coin is under 1 h old |
| ignition | 1 h volume ≥ 5k USD and ≥ 2× the 1 h volume an hour ago, with a new coin in the hour or unique traders +50% |
| fading | 1 h volume ≤ 40% of its 24 h high, or ≤ 60% of an hour ago |
| peak | otherwise: hot, near its 24 h high, growing under 2× |

**Copy-cat saturation** (`*` in the table): at least 5 coins, at least 3 of them new in 6 h, and the coins after the 3
oldest together hold under 25% of the narrative's 1 h volume. The copies are launching, but they are not getting the
volume.
