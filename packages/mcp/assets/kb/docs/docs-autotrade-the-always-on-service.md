---
id: docs-autotrade-the-always-on-service
title: Autotrade (paper) › Running it all day › The always-on service
kind: docs
page: autotrade
page_title: Autotrade (paper)
heading: The always-on service
anchor: the-always-on-service
url: https://dexterm.xyz/docs/autotrade#the-always-on-service
tags:
  - docs
  - autotrade
  - always-on
  - service
  - running
  - all
  - day
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

Install it once and the strategies in your `autotrade.json` (https://dexterm.xyz/docs/autotrade#the-autotradejson-file) keep running: they start when you log in, start again after a crash, never run twice, stop at once on any kill switch, and tell you when they cannot run.

```
dexterm autotrade service install --dry-run   # shows exactly what it would write; writes nothing
dexterm autotrade service install --load      # writes it and loads it
dexterm autotrade service status              # running?, guard, crashes, each strategy
dexterm autotrade service stop                # no new entries now; exits keep running; stays stopped
dexterm autotrade service start               # start again (lifts a stop)
dexterm autotrade service logs                # the end of its log
dexterm autotrade service uninstall           # stop, unload, remove exactly what install wrote
```

- **What install writes.** One small job that runs `dexterm autotrade service ensure` every minute and at login: a LaunchAgent in `~/Library/LaunchAgents/` on macOS (no `KeepAlive`), a systemd user timer in `~/.config/systemd/user/` on Linux, a scheduled task on Windows. Install prints every file in full and checks that it parses before writing anything; `--dry-run` stops there, and without `--load` nothing is loaded. It runs while you are logged in (on Linux, `loginctl enable-linger` is your choice for after logout). Each `DEXTERM_HOME` gets its own job, so a test home never replaces your real one.
- **What a tick does.** `ensure` does nothing while the service's heartbeat is fresh, and otherwise starts it. The service runs `dexterm autotrade run --all --paper` for every strategy you listed, with the same lock, run files, `Q` screen and switches as a run you start by hand. Flags for it go in `~/.dexterm/autotrade/service.json` (`{ "schema": "dexterm-autotrade-service-config/1", "runArgs": ["--model", "sonnet"] }`; only `--model`, `--sol-usd`, `--config`, `--replay`, `--ms-per-tick`, `--max-minutes` and `--stub`).
- **After a crash or a restart.** A crash costs at most a minute. The new run checks the crashed run's file, takes over the paper positions it left open (their stops, take-profits, trails and maximum hold keep running from the original entry), and never buys a coin the crashed run already took. An order that had not filled never happened, and it is never sent again.
- **A crash loop gives up.** Restarts after a crash wait 0, 0, 1, 2 and 4 minutes; the sixth crash within an hour leaves the service down with one notification. `dexterm autotrade service status --clear` lets it start again once you have read the log.
- **A stop stays a stop.** `service stop`, `dexterm autotrade stop`, `!` on the `Q` screen, `/kill` from your Telegram bot, `dexterm wallet panic`, or simply creating the file `~/.dexterm/autotrade/service/STOP`: new entries halt on the next step, open positions keep their exits until they close (`service stop --flatten --yes` sells them), and the service stays stopped until `dexterm autotrade service start`. Logging out or shutting down is not a stop: it starts again at your next login.
- **The guard.** Every 10 seconds the service checks the machine and the data. These pause new entries until they clear, and never the exits on what you hold:

  | guard | when |
  |---|---|
  | disk low | free space under `runner.json` `disk.minFreeGb` (5 GB by default); it lifts 1 GB above that |
  | load high | the 1-minute load above `load.pauseAboveLoad1m` for `load.sustainSec`; it lifts below `load.resumeBelowLoad1m` |
  | busy process | a `load.busyProcs` pattern is running (a render, a test suite) |
  | stale data | no strategy has seen a market tick for 5 minutes |

  It also tells you, without pausing anything, when the usage guard or a day cap holds new sessions back, when a strategy halts itself on its loss limits, when the strategies' heartbeat goes quiet, and when your market history has stopped growing (`dexterm record install` sets that up; the service trades without it, your backtests need it).
- **Your bot.** When your Telegram bot (https://dexterm.xyz/docs/telegram) is set up, the service runs it: every strategy's alerts, `/status`, `/pause` and `/kill`, plus a message when the service is down, gives up after a crash loop, a guard trips, a strategy halts on its caps, or the data goes stale.
- **Light on the machine.** It runs at low priority (nice 10, low IO priority), with a 512 MB memory cap (a leak ends in a restart, not a slow machine), and its logs in `~/.dexterm/autotrade/logs/` are capped at a few MB each.
