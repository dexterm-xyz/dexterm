---
id: docs-larp-the-larp-score
title: LARP detector › The LARP score
kind: docs
page: larp
page_title: LARP detector
heading: The LARP score
anchor: the-larp-score
url: https://dexterm.xyz/docs/larp#the-larp-score
tags:
  - docs
  - larp
  - score
  - detector
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/larp.md
date: 2026-10-16
---

`larp_check` also returns a **LARP score from 0 to 100**: the sum of named flags, each with its points and the evidence that raised it. Higher means more of the things that went with LARP coins showed up. It summarises the flags; it is not a verdict and does not replace the one above.

| band | score | |
|---|---|---|
| low | under 25 | few flags |
| medium | 25 to 49 | several flags; link shape alone tops out here |
| high | 50 or more | needs page, domain, GitHub or X evidence, not link shape alone |

| flag | points | weight |
|---|---|---|
| no Telegram advertised | 12 | fitted |
| no X account advertised | 10 | fitted |
| no website advertised | 9 | fitted |
| X link is a single post or a community, not an account | 5 | fitted |
| the "website" is a social page | 1 | fitted |
| the domain does not name the token · throwaway-priced TLD | 0 | fitted (did not go with bad outcomes, so not listed) |
| launchpad / link-hub / free-host page as the website | 4 / 2 / 2 | prior (too rare to fit) |
| sources advertise different sites or X accounts | 8 | prior |
| wallet-drainer markers on the page | 30 | prior |
| default or placeholder page | 15 | prior |
| asks to connect a wallet · never names the token | 8 · 8 | prior |
| domain under 30 days old · registrant privacy | 8 · 2 | prior |
| no GitHub advertised · archived · a fork · no push in 180 days | 2 · 4 · 4 · 4 | prior |
| X account suspended · does not exist | 20 · 15 | prior |
| X account under 7 days old (or under 30 days) | 12 (6) | prior |
| under 50 followers · no posts in 30 days | 5 · 6 | prior |
| the website's X link and the advertised account differ | 10 | prior |
| a linked post now shows another handle · the account does not link the site | 5 · 3 | prior |

**Fitted** points come from the recorded history below (link shape is the only part of the check that history can replay). **Prior** points were written from the skill's rules before any data and are labelled `prior` in every result.

**Missing data never lowers the score.** A page that could not be read, an RDAP or X lookup that failed, goes to a `missing` list with the points it could have added, and the result shows the range: "37, could be up to 58". Nothing unread is scored as clean.

Where it shows: the `larp_check` MCP result (`score`, `band`, and `larp_score` with every flag, its points, its weight and its evidence, the range and the `missing` list; the existing fields are unchanged), the analyst panel after a LARP check (a gauge with the three biggest reasons, drawn from the tool's own result, never from the model's text).

> warn: a LARP verdict is a risk flag, not a certificate. Public HTML cannot prove a working product, a team's identity or who owns an account; domain age, a clean script scan and a GitHub with commits are evidence, not proof, and a real product can still go to zero.
