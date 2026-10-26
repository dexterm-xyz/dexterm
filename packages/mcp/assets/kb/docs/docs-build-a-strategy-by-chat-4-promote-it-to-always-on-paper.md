---
id: docs-build-a-strategy-by-chat-4-promote-it-to-always-on-paper
title: Build a strategy by chat › 4. Promote it to always-on (paper)
kind: docs
page: build-a-strategy-by-chat
page_title: Build a strategy by chat
heading: 4. Promote it to always-on (paper)
anchor: 4-promote-it-to-always-on-paper
url: https://dexterm.xyz/docs/build-a-strategy-by-chat#4-promote-it-to-always-on-paper
tags:
  - docs
  - build-a-strategy-by-chat
  - promote
  - always-on
  - paper
  - build
  - strategy
  - chat
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/build-a-strategy-by-chat.md
date: 2026-10-16
---

When the forward test is done, the analyst can **propose** the promotion (`strategy_promote_propose`) or you can ask for it yourself:

```
dexterm autotrade promote <id> --to always-on
dexterm autotrade promote list | show <pp-id> | apply <pp-id> | dismiss <pp-id>
```

Every promotion shows an evidence card first: the ladder, the backtest, the forward test and the comparison. Applying it needs your `y` on your own terminal (a pipe, a flag or an agent cannot give it), or `A` then `y` on the `Q` screen's journey view. The strategy then joins `autotrade.json` as a paper member, next to your other entries, and the always-on service runs it from its next start (`dexterm autotrade service status`).
