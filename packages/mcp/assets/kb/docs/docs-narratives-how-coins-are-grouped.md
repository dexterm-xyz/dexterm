---
id: docs-narratives-how-coins-are-grouped
title: Memes and narratives (experimental) › How coins are grouped
kind: docs
page: narratives
page_title: Memes and narratives (experimental)
heading: How coins are grouped
anchor: how-coins-are-grouped
url: https://dexterm.xyz/docs/narratives#how-coins-are-grouped
tags:
  - docs
  - narratives
  - coins
  - are
  - grouped
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

1. **Normalise** the name and ticker (and the description or social handles when the data layer has them): leetspeak
   (`Z0RP`), repeated letters (`ZOOOORP`), camelCase (`ZorpWifHat`), emoji (🐸 → frog), glued tickers split against a
   vocabulary learned from other names (`BABYZORP` → baby + zorp), and copy-cat affixes (`BABY`, `MINI`, `2.0`, `INU`,
   `AI`) kept as weak words so "Baby X" lands next to X.
2. **Embed** each coin with a local model. The default is built in: a hashed vector of the meme words, their letter
   trigrams and the lexicon themes (dogs, politics, ai-agents, holiday-seasonal, …). An optional small open model,
   all-MiniLM-L6-v2 on CPU through transformers.js, or any local Ollama embedding model, adds meaning links such as
   kitty to cat (`DEXTERM_NARRATIVE_EMBEDDER=minilm` or `ollama`).
3. **Cluster** incrementally in first-seen order. A coin joins the closest narrative it shares a meme word with (or, with
   a semantic model, a currently hot one) if it is close enough to that narrative's centre and to the coin that started
   it. Otherwise it starts a new narrative. Ids are stable (`nar_…`) and narratives never merge or split afterwards.
   The label is the most common word or two-word phrase.
