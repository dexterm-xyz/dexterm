---
id: docs-classifier
title: Classification models
kind: docs
page: classifier
page_title: Classification models
url: https://dexterm.xyz/docs/classifier
tags:
  - docs
  - classifier
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

Pick the model that scores coins with probabilities (an open Kev model on your own machine, TypeSafe's hosted Jev with your own key, or the built-in scores), with how each one measured on dexterm's own labelled history.

**Experimental.** A classification model answers *typed questions* about one coin with a probability for every possible answer. dexterm asks two questions:

- `drain_6h`: will this coin be drained within 6 hours (liquidity pulled, or the price under a fifth of now)?
- `outcome_6h`: RUG, WIN (at least 3x on a pool that still holds $10k) or DUD over the next 6 hours.

A third set, `narrative`, sorts a coin into a narrative category (animal, AI, politics, celebrity, culture, tech, other).

Every answer is a **model estimate**: it carries the model id, the latency, the cost and a note on how its probabilities were calibrated. It is not advice and not a trade signal. Nothing here signs, trades, arms a strategy or changes a limit. The token's own text (name, symbol, description) goes through the prompt firewall first, and text that tries to steer the model (a bio that tells it what to answer) is removed before any model sees it.
