---
id: docs-autotrade-which-account-day-caps-and-the-usage-guard
title: Autotrade (paper) › Running it all day › Which account, day caps and the usage guard
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: Which account, day caps and the usage guard
anchor: which-account-day-caps-and-the-usage-guard
url: https://dexterm.xyz/docs/autotrade#which-account-day-caps-and-the-usage-guard
tags:
  - docs
  - autotrade
  - which
  - account
  - day
  - caps
  - usage
  - guard
  - running
  - all
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

These come from `~/.dexterm/autotrade/runner.json` (`dexterm-runner/1`), which stays on your machine and is never part of a strategy or a shared file. Without it the runner uses your default `claude` login and these defaults:

```json
{ "schema": "dexterm-runner/1",
  "account": { "kind": "native" },
  "caps": { "candidateSessionsPerDay": 48, "positionSessionsPerDay": 48, "modelUsdPerDay": 20, "turnsPerDay": 2000 },
  "allowanceGuard": { "fiveHourMax": 0.6, "sevenDayMax": 0.8, "onLimit": "pause-until-reset" } }
```

- `account.kind` is `native` (your default login), `oauth-token` (a long-lived Claude login token from a helper command or a keychain item, handed to `claude` on a file descriptor; it is never on a command line, in a file or in the run file), `config-dir` (a separate Claude config folder with its own login) or `api-key` (a pay-as-you-go key from a helper or the keychain, in the session's environment only). The file names where to fetch a secret, never the secret.
- The stricter of `runner.json` and the strategy applies.
- A day is a real day by the clock (it starts at 00:00 UTC), also in a `--replay`: a fast replay of many recorded days still spends at most one day's caps per real day.
- The usage guard reads the usage your Claude sessions report: above 60% of the five-hour or 80% of the seven-day allowance no new session starts, and after a usage limit the runner waits for the reset.
