---
id: docs-strategy-factory-drive-the-factory-from-your-agent
title: Strategy factory › Drive the factory from your agent
kind: docs
page: strategy-factory
page_title: Strategy factory
heading: Drive the factory from your agent
anchor: drive-the-factory-from-your-agent
url: https://dexterm.xyz/docs/strategy-factory#drive-the-factory-from-your-agent
tags:
  - docs
  - strategy-factory
  - drive
  - factory
  - agent
  - strategy
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/strategy-factory.md
date: 2026-10-16
---

Any agent connected to dexterm's MCP server (https://dexterm.xyz/docs/agents) (Claude Code, the stream agent, your own) can work the same loop as the chat, on paper only. It reads, it can offer a candidate of its own, and it can pause the factory; anything that changes your always-on list waits for you.

**Reads:** `factory_status` (paused or not, the last and next run, candidates by stage, every cap with what is in use, proposals waiting for you), `factory_candidates`, `factory_why` (one candidate's parents, the evidence numbers it cited, the lessons it saw), `factory_lessons` (lines from the held-out days hidden), `factory_evidence` (the table the factory's own analyst was shown), `strategy_compare_lab` (backtest, held-out, forward test and the running lab account side by side). Their text is untrusted data, framed as such.

**A worked example.** The agent:

1. calls `factory_status`: not paused, 2 of 5 candidates active, 1 of 3 Claude calls used today;
2. reads `factory_lessons` and `factory_evidence`, and picks a base from the table, say row S2;
3. calls `factory_offer_candidate` with `base` and `parents` from the table, a `name`, ops on `/entry` and `/exits` (or a whole strategy file), a reason for every rule, and the numbers it relies on as citations, for example `{"ref": "S2.mean2xPct", "value": -8.0}`;
4. gets back an offer id (or the reasons it was refused), and later sees it in `factory_candidates` as `GENERATED`, made by `mcp:<its name>`, with its held-out line and forward-test progress.

An offer goes through **the same gate as the factory's own output**: the reply shape, the rule policy (no safety switch, no sizing, carry or re-entry change), the strategy validator, every cited number checked against the evidence it was shown (a number that is not there gets it refused), the wording check, and the duplicate checks. A passing offer waits in the factory inbox (at most 3, 6 a day). The next factory run, or `factory_run_now` with `analyst: false` (inbox only: no Claude call, nothing spent), stores it as a paper candidate, tests it once on held-out days the evidence did not include, and queues a paper forward test under your caps. The agent cannot set its bankroll, caps, mode or budget, and cannot promote it.

**Controls:**

| tool | what it does | how to undo it |
|---|---|---|
| `factory_pause` | writes the agent's own pause marker (`AGENT-PAUSE`); no run starts | `factory_resume`, or `dexterm autotrade factory resume` |
| `factory_resume` | lifts the agent's pause only; your `FACTORY-STOP` stays, and a resume proposal waits for you | `factory_pause` |
| `factory_run_now` | starts one run (one at a time, 30 minutes apart, 4 a day); every cap applies inside it | `strategy_retire` on what it made |
| `strategy_retire` | retires a candidate the factory generated (never a preset or one of yours), with a reason; if you put that candidate on your always-on list, it is only a proposal (it would turn the entry off) | `dexterm autotrade factory unretire <id>` |
| `strategy_enable` / `strategy_disable` | only **propose** the paper always-on switch; `autotrade.json` is your file | not applied until you confirm |

You apply an agent's proposal with `dexterm autotrade factory confirm ` (or `--cancel`), or by writing its code in the in-app chat ("confirm C1A2B3C"; a bare "yes" is not enough for an agent's proposal). `dexterm autotrade factory pending` lists them; they expire after 24 hours. The in-app chat itself keeps using its own preview-and-confirm tool.

**What no agent tool can do:** sign or send anything, set a mode, change a bankroll, a cap or a Claude budget, raise its own limits, promote past paper (promotion stays `strategy_promote_propose` and your key), delete or overwrite a preset or one of your strategies, write outside the factory and strategy files, or remove `FACTORY-STOP`.
