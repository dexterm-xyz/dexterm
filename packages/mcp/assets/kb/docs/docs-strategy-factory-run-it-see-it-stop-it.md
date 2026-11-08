---
id: docs-strategy-factory-run-it-see-it-stop-it
title: Strategy factory › Run it, see it, stop it
kind: docs
page: strategy-factory
page_title: Strategy factory
heading: Run it, see it, stop it
anchor: run-it-see-it-stop-it
url: https://dexterm.xyz/docs/strategy-factory#run-it-see-it-stop-it
tags:
  - docs
  - strategy-factory
  - run
  - stop
  - strategy
  - factory
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/strategy-factory.md
date: 2026-10-16
---

```
dexterm autotrade generate                 # one run now (same as: dexterm autotrade factory run)
dexterm autotrade generate --stub          # a dry run with a stub instead of Claude: no spend
dexterm autotrade factory run --focus "try a sell ladder on older coins"   # tell one run what to try (one line, 500 characters at most)
dexterm autotrade factory status           # last run, spend today, caps, every candidate and its stage
dexterm autotrade factory show <id>        # why a candidate was made, and its held-out result
dexterm autotrade factory retire <id>      # retire a candidate yourself
dexterm autotrade factory lessons          # what the factory has learned so far
dexterm autotrade factory stop             # writes FACTORY-STOP: nothing runs until you resume
dexterm autotrade factory resume
```

To run it on a schedule:

```
dexterm autotrade factory install          # shows the scheduler file it would write; writes it, does not load it
dexterm autotrade factory install --load   # writes and loads it
dexterm autotrade factory uninstall        # removes exactly what install wrote
```

On macOS this is a LaunchAgent, on Linux a systemd user timer; the file is generated, never hand-edited. The default slot is 04:10 local time, after the nightly tuning job. An interval that divides the day runs at fixed slots counted from that time (`factory config set intervalHours 4` = 00:10, 04:10, 08:10, 12:10, 16:10, 20:10). A scheduled run skips itself while another run holds the lock or the machine has less than `minFreeMemMb` (4096 MB) of memory available; a run you start by hand does not check memory. Only scheduled runs count for the cadence, so a run by hand never makes the next slot skip. On Windows, run `dexterm autotrade factory run --scheduled` from Task Scheduler yourself.
