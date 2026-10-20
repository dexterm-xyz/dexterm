---
id: docs-screens-dev-history
title: Screens tour › Dev history
kind: docs
page: screens
page_title: Screens tour
heading: Dev history
anchor: dev-history
url: https://dexterm.xyz/docs/screens#dev-history
tags:
  - docs
  - screens
  - dev
  - history
  - tour
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/screens.md
date: 2026-10-16
---

*Since 0.1.5.* "Has this deployer rugged before?" The ON-CHAIN panel adds the creator's **recorded** track record, from dexterm's own history recorder (https://dexterm.xyz/docs/configuration#history-recorder), keyless:

| row | what it shows | example |
| --- | --- | --- |
| Dev rugs | rugs out of the creator's **labelled** prior launches, the sample, and how long ago the newest of those labels settled; red at two or more (the `serial_rugger` flag), `unknown` with no labelled record | `2/5 · n=5 · rec 3d` |
| Dev launches | prior launches the recorder linked to this wallet, how long ago the newest was seen, and which feed named the creator (`jup`, `pump`, `rc`) | `n=5 · rec 2h · dev:jup` |
| Dev sold bag | median minutes from launch to the dev's exit on prior launches (held over 0.5 % of supply, then 0.1 % or less), the sample, and the age of the newest exit seen | `med 20m · n=3 · rec 1d` |
| Dev linked | the creator's funder or the linked cluster it sits in (same funder, same-block bundle, transfers) from the wallet-intel scan (https://dexterm.xyz/docs/screens#bubble-map), and how long ago that scan ran | `funder 3w · scan 4m` |
| Linked dev rugs | labelled rugs by the other wallets in that cluster that dexterm saw launching coins, how many such wallets, and the age of their newest label | `1 · n=1 devs · rec 7d` |

`rec` is dexterm's own recorder, `scan` the wallet-intel scan; every age is how old the newest datum behind the number is.

- **Where the creator comes from.** The wallet a keyless source names when dexterm sees the coin: Jupiter's `dev` field on every token row, a PumpPortal create, or RugCheck's new-token feed. The first source wins and is recorded with the time. GoPlus is asked only by the MCP tool, as a last resort.
- **Where the outcomes come from.** The recorder's code-only labels (rug, dead, fade, flat, runner; the 72-hour label when known, else the longest one settled). They are the keyless-proxy tier: a rug is a liquidity collapse the recorder saw, not a verified on-chain drain.
- **Honest by construction.** Every row names its source, its sample and the age of its newest datum. No record is `unknown`, never "clean". Only coins this machine's recorder saw count, so a deployer's launches dexterm never saw are missing; run `dexterm record` (https://dexterm.xyz/docs/configuration#headless-recorder-dexterm-record) to keep it fed. It is a risk flag from observed history, never a certificate. On a window too short for every ON-CHAIN row, the red, then amber rows stay and the last line says how many rows are hidden (`+3 rows hidden`).
- **Alerts.** The rule field `devrugs` is the creator's labelled rugs (unknown = no match). A brand-new pair from a wallet with a record joins the rule rows, so this fires on launch:

```text
when devrugs >= 2 then alert(warn, "new coin from a wallet that rugged before") scope newpairs
```

- **For agents.** The read-only `dev_history` MCP tool returns the same report by mint or creator wallet; `get_dev_history` and the dossier fill prior launches and rugs from it (tier `local-history`), so the deterministic analysis pack raises `serial_rugger` on recorded history.
