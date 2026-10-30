---
id: docs-configuration-headless-recorder-dexterm-record
title: Configuration and files on disk › History recorder › Headless recorder (dexterm record)
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Headless recorder (dexterm record)
anchor: headless-recorder-dexterm-record
url: https://dexterm.xyz/docs/configuration#headless-recorder-dexterm-record
tags:
  - docs
  - configuration
  - headless
  - recorder
  - dexterm
  - record
  - history
  - files
  - disk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/configuration.md
date: 2026-10-16
---

The recorder above only grows while the terminal is open. `dexterm record` is **opt-in**. It runs the same recorder jobs with no terminal UI: snapshots and feed membership, the new-pairs stream, the 1 h to 72 h outcome sweeps, labels and retention. Your local history keeps growing for backtests while dexterm is closed.

```sh
$ dexterm record run --once --verbose     # one observation pass + one maintenance pass, then exit
$ dexterm record run                      # keep going: a feed refresh every 60 s (--interval S)
$ dexterm record status                   # db size, snapshots, outcomes, today's sweep calls, LaunchAgent state
$ dexterm record install --dry-run        # print the macOS LaunchAgent it would write; writes nothing
$ dexterm record install --load           # write it to ~/Library/LaunchAgents (no sudo) and load it
$ dexterm record uninstall --unload       # stop and remove it
$ dexterm record run --focus-ticks --retention-mb 3000   # also sample focus coins every 5-10 s; evict old history at 3 GB
$ dexterm record run --exit-probes --focus-module ./my-focus.mjs   # + a sell quote a minute for held coins; extra focus coins from your module
```

- **Nothing turns itself on.** The collector runs only when you start it. `install` writes a user-level LaunchAgent and loads it only with `--load`. A LaunchAgent does not start before you log in.
- **Same budgets as the app.** Every request goes through the data layer's rate limiter and health gate, and the outcome sweeps keep their own per-sweep and per-day caps. It never builds a signer, never trades and never prints an RPC key.
- **A disk cap.** Above `--max-db-mb` (1024 by default) it pauses new observations, while labels and retention keep running, so the database cannot grow without bound. With `--retention-mb N` it never pauses: once the used space reaches N MB the oldest history goes first (the newest hour is always kept). `--retention-days D` expires snapshot rows, outcome re-checks included, after D days instead of 90.
- **Focus ticks for autotrade backtests** (`--focus-ticks`): a sample every 5 seconds for coins you hold on paper or have open and every 10 seconds for your watchlist and autotrade candidates, plus 1-minute candles built from those samples, in DexScreener batches of 30 with a daily call ceiling. What is kept and for how long is in recorded history (https://dexterm.xyz/docs/data-sources#recorded-history-and-retention). `install` writes these flags into the LaunchAgent only when you pass them.
- **Exit probes** (`--exit-probes`, implies `--focus-ticks`): once a minute, for every coin you hold, a keyless Jupiter quote to sell $50 of it into SOL, written as the SOL out, the price impact and the hops, or the error ("no route" is a drained pool). Quotes only: nothing is built, signed or sent. At most 4 quotes a minute for all coins together and a daily ceiling, from the same Jupiter budget as the app.
- **Your own focus coins** (`--focus-module PATH`, implies `--focus-ticks`): an ES module whose `focus(now)` returns extra coins (a mint and a role: `held`, `open`, `candidate` or `watch`) for the tick lane, for coins your own tools hold outside dexterm.
- **Recurring backtests.** 0.1.3 also ships the logic behind recurring skill backtests: a rolling held-out window, a frozen comparison set, and a gate that only *proposes* a tuning when it beats the noise. Nothing changes a skill on your machine. A tuning reaches you only through a normal release, with its measured numbers, including weak ones (see LARP detector (https://dexterm.xyz/docs/larp)).
