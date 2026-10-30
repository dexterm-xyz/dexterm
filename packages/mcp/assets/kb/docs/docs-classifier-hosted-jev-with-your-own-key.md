---
id: docs-classifier-hosted-jev-with-your-own-key
title: Classification models › Hosted Jev with your own key
kind: docs
page: classifier
page_title: Classification models
heading: Hosted Jev with your own key
anchor: hosted-jev-with-your-own-key
url: https://dexterm.xyz/docs/classifier#hosted-jev-with-your-own-key
tags:
  - docs
  - classifier
  - hosted
  - jev
  - own
  - key
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

```
dexterm classifier key set          paste your TypeSafe API key (hidden input; stored 0600 under ~/.dexterm/keys)
dexterm classifier pick jev-hosted
```

dexterm never ships or shares a key. The key is sent only to `https://api.typesafe.ai`, never printed, and never stored in `classifier.json`. `TYPESAFE_API_KEY` in the environment works too. Each call counts tokens. Set your price per million input tokens in `~/.dexterm/classifier.json` (`jev.pricePerMTokUsd`) to see a cost in dollars; until you do, the cost shows as *unpriced*, never as $0. A daily call cap (`jev.maxCallsPerDay`, default 1,000) stops calls before they reach the network. A rate limit from the API is reported with its retry time.
