---
id: docs-telegram-read-only-data-check-top-and-signals-experimental
title: Telegram (your own bot) › Read-only data: /check, /top and /signals (experimental)
kind: docs
page: telegram
page_title: Telegram (your own bot)
heading: Read-only data: /check, /top and /signals (experimental)
anchor: read-only-data-check-top-and-signals-experimental
url: https://dexterm.xyz/docs/telegram#read-only-data-check-top-and-signals-experimental
tags:
  - docs
  - telegram
  - read-only
  - data
  - check
  - top
  - signals
  - experimental
  - own
  - bot
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/telegram.md
date: 2026-10-16
---

Three commands that only **read**, for the account you paired, in its private chat. Read-only; dexterm never holds a key; not financial advice.

| command | what you get |
|---|---|
| `/check <CA>` | one coin by its mint address: the LARP score (https://dexterm.xyz/docs/larp) (0 to 100, the named flags behind it, and how far it could rise with the checks that could not be read), the risk facts (mint and freeze authority, top-10 holders, dev share, LP locked, rug score), market cap, liquidity, holders and the coin's age, each with the age of its data, and whether your runner holds the coin or has it as a candidate |
| `/top [N]` | the first N coins (default 5, at most 10) of the screener's trending list, your runner's own coins marked |
| `/signals [N]` | the last N signals (default 5, at most 20) your runner raised since the bot came on: screen matches, safety refusals, the drain guard, stuck bags, guards, halts and paper fills |

They need a runner on live data (`dexterm autotrade run <id> --paper`, or the always-on service). In a replay, or with no run, `/check` says there is no live data and `/top` falls back to your runner's own coins. The LARP score is evidence, not a verdict, and not a safety check.

What keeps them read-only:

- **No write path.** They are answered by a part of the bot that can only call three read tools (token data, the LARP check and the screener). It cannot reach `/pause`, `/kill`, `/flatten`, `/use`, an approval, an order, a signal or a limit, and it answers with text only: never a button.
- **Only your paired chat.** The same allowlist as `/status`: your account, in the private chat you paired it in, with the notify or control tier. Any other account, chat or group gets no answer and nothing is read.
- **Token text is data.** Names, symbols and descriptions come from the coin's creator. They pass through the same prompt firewall the analyst uses, and are shown quoted, in plain text: links, addresses, commands, mentions, bare domains, hashtags, cashtags and invisible or right-to-left characters are replaced or made inert. A mint is shown only after it checks out as an address, and only shortened (`abcd…wxyz`). No model reads these answers.
- **Short and clean.** One answer is at most 26 lines and 1,800 characters. Keys, file paths and your computer's host and login names never appear, also not inside an error from a data source.
- **Limited.** Five data requests a minute per chat (on top of the 10 commands a minute), one `/check` at a time. Over the limit the bot says so once, then stays quiet for the minute. `/kill` and `/pause` are never limited.
- **Honest about gaps.** A source that fails or does not answer in time is named ("could not be read", with the reason); nothing is filled in by a guess.
