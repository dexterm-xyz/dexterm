---
id: docs-ollama-what-stays-outside-the-model
title: Use a local model with Ollama › What stays outside the model
kind: docs
page: ollama
page_title: Use a local model with Ollama
heading: What stays outside the model
anchor: what-stays-outside-the-model
url: https://dexterm.xyz/docs/ollama#what-stays-outside-the-model
tags:
  - docs
  - ollama
  - stays
  - outside
  - model
  - use
  - local
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/ollama.md
date: 2026-10-16
---

Whatever profile you pick, and whichever engine runs:

- your strategy and runner caps, and the kill switch (command, hotkey, the panic file);
- mandate tiers: arming a mandate is a physical keypress, and no model or agent can arm one;
- the strategy clamp: every size a model asks for is cut to your strategy and your runner caps, exactly as for Claude;
- Telegram approvals, when you use them: a one-time button, bound to a nonce, a hash and an expiry and to your account, tapped by you;
- the prompt firewall: token names, socials and page text reach a local model wrapped as `<untrusted>` data, byte for byte as they reach Claude.

A model can only ask. It cannot raise a cap, arm a mandate or change its own profile. There is no live mode for it to turn on: dexterm trades on paper only.
