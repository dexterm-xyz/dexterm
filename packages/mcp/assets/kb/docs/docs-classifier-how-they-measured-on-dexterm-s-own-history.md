---
id: docs-classifier-how-they-measured-on-dexterm-s-own-history
title: Classification models › How they measured on dexterm's own history
kind: docs
page: classifier
page_title: Classification models
heading: How they measured on dexterm's own history
anchor: how-they-measured-on-dexterm-s-own-history
url: https://dexterm.xyz/docs/classifier#how-they-measured-on-dexterm-s-own-history
tags:
  - docs
  - classifier
  - they
  - measured
  - dexterm
  - own
  - history
  - classification
  - models
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/classifier.md
date: 2026-10-16
---

dexterm's benchmark (October 2026) asked each model about coins whose outcome we already know: 1,054 coins from the LARP eval set (rugged or dead within 72 hours?) and 1,800 coins from the recorder's history (drained within 6 hours?). The rules and the pick were fixed before the final held-out coins were scored, and those were scored once. AUROC says how well a model ranks the coins that went bad above the ones that did not: 0.5 is a coin flip, 1.0 is perfect.

| model | where it ran | drained within 6 h (held-out) | bad within 72 h (held-out) | time per coin | cost |
|---|---|---|---|---|---|
| Built-in scores (default) | anywhere | 0.50 | 0.71 | under 1 ms | free |
| Kev 0.8B (Q8) | Intel Mac mini CPU | 0.54 | 0.46 | 3-7 s | free |
| Kev 4B (Q4) | desktop and Mac mini CPUs | 0.52 | 0.73 | 5-14 s | free |
| Kev 9B (Q4) | RTX 4080 GPU | 0.53 | 0.79 | 0.06-0.2 s | free |
| Claude haiku (comparison only) | Claude CLI | 0.62 | 0.86 | about 5 s | about $0.0009 |
| Kev 27B, hosted Jev, open JEV | not measured | | | | |

What this means:

- **No model is good at this yet.** Predicting a coin's next six hours from what is known now is hard for everything we tried, including the built-in scores. Treat every estimate as one weak input, never as a verdict.
- **Kev 0.8B ranks coins no better than chance** and gives almost the same number for every coin, so dexterm never suggests it.
- **Kev 4B** is the model `dexterm classifier pull` suggests if you want a local model: it was the best Kev on the development coins. On the held-out coins it tied the built-in scores (no better, no worse), so the built-in scores stay the default.
- **Claude (zero-shot) ranked best** on both questions, but it needs your Claude login, the network and a small cost per coin, so it is a comparison point, not a default.
- **Kev 9B** (measured later, on a GPU) is fast, a fraction of a second per coin, but no better. On the development coins it trailed Kev 4B on the drain question. On the held-out coins it tied both the built-in scores and Kev 4B: its 0.79 on the LARP question and 0.53 on drain are within chance variation of theirs. So `kev-4b-q4` stays the suggestion, and the 9B model is there if you want to try it.
- **Kev 27B and the open JEV models were not measured** (no file llama.cpp can run, or a GPU larger than 16 GB needed). They may do better; we do not know.
- **Hosted Jev was not measured**: it needs a TypeSafe key, and dexterm's own tests run against a stand-in server only.
- Kev was trained on general text decisions (intents, reviews, policies), not on memecoins. Its authors' accuracy figures are about those tasks, not this one.

`dexterm classifier bench` times the model you picked on your own machine (seconds per coin and per 1,000 coins).
