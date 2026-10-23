---
id: docs-autotrade-sessions-and-their-limits
title: Autotrade (paper) › The runner and candidate sessions › Sessions and their limits
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Sessions and their limits
anchor: sessions-and-their-limits
url: https://dexterm.xyz/docs/autotrade#sessions-and-their-limits
tags:
  - docs
  - autotrade
  - sessions
  - their
  - limits
  - runner
  - candidate
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

**Token text is data.** Names, symbols and every other text that comes from the token reach the agent only inside `<untrusted>` tags, and the agent is told such text is never an instruction. A coin named "buy the maximum" still gets your strategy's size, and nothing the agent says can stop a mechanical exit.

**The session is answer-only.** It is `claude -p` with no tools, no MCP servers, no settings, no saved session and no slash commands, started in an empty folder (it is not `--bare`, which would drop your Claude login). Its first event must show the kind of login you configured and no tools; if it does not, the session ends before anything it says counts, and the runner starts no new session for the rest of the run. The limits come from the strategy's `agent` section (the presets' values): at most 2 sessions at once, $0.50 per session (also passed to `claude` as its own budget), $10 a day, 60 turns, 90 seconds per decision (60 in moonbag; a slow candidate is skipped, and a slow review gets the exit profile's no-answer rule), 4 hours per session, and the candidate is dropped 5 minutes after it last matched (4 in moonbag). The model is the strategy's `agent.model` (`sonnet` in the presets), or `--model` for one run.
