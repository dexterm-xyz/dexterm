---
id: autotrade-factory-agents
title: The strategy factory from an outside agent: read it, offer a candidate, watch it, pause it (paper)
kind: app-help
screen: all
feature: autotrade-factory
tags:
  - app-help
  - autotrade
  - strategy
  - factory
  - offer
  - candidate
  - generated
  - evidence
  - lessons
  - provenance
  - lab
  - inbox
  - pending
  - unretire
commands:
  - autotrade
tools:
  - factory_status
  - factory_candidates
  - factory_why
  - factory_lessons
  - factory_evidence
  - strategy_compare_lab
  - factory_pause
  - factory_resume
  - factory_run_now
  - strategy_enable
  - strategy_disable
  - strategy_retire
  - factory_offer_candidate
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

Any agent wired to dexterm's MCP server (Claude Code, the stream agent, your own) can drive the strategy factory the way the in-app chat does, on paper only. Reads: factory_status (paused or not, last and next run, candidates by stage, every cap with what is in use, FACTORY-STOP, agent offers, proposals waiting for you), factory_candidates (each GENERATED candidate: parents, rationale, expected failure, held-out line, forward progress, retire reason), factory_why (one candidate's provenance: parents, ops, the evidence numbers it cited, the lessons lines it saw), factory_lessons (lessons.md, held-out lines hidden), factory_evidence (the evidence table the factory's own analyst was shown), strategy_compare_lab (backtest, held-out, forward test and running lab account side by side). Worked example: the agent reads factory_status, then factory_lessons and factory_evidence, then calls factory_offer_candidate with a base and parents from the evidence, ops on /entry and /exits (or a full strategy document), a reason for every rule and citations like {"ref": "S2.mean2xPct", "value": -8.0}; the same gate as the factory's own output checks it (ops policy, validator, every number against that evidence, wording, duplicates) and queues it; the next factory run (or factory_run_now with analyst false: inbox only, no Claude call) stores it as a GENERATED paper candidate tagged mcp:<client>, tests it on held-out days the evidence did not include and queues a paper forward test; the agent watches it with factory_candidates. Controls: factory_pause writes the agent's own AGENT-PAUSE and factory_resume lifts only that (your FACTORY-STOP is yours: an agent cannot remove it); strategy_retire retires a GENERATED candidate (never a preset or yours; undo: `dexterm autotrade factory unretire <id>`; a candidate you put on the always-on list is only PROPOSED for retirement and waits for your confirm); factory_run_now starts one run (one at a time, 30 min apart, 4 a day; every cap applies); strategy_enable / strategy_disable only PROPOSE the paper always-on switch: you apply one with `dexterm autotrade factory confirm <code>` or by naming the code in the in-app chat (`factory pending` lists them; 24 h to live). No tool can sign or send, set a mode, a bankroll, a cap or a Claude budget, or promote: promotion stays strategy_promote_propose and your own key. Candidates are not edges; paper and simulated; not financial advice.

CLI: `dexterm autotrade`.
