---
id: screen-autotrade
title: The autotrade (paper) screen
kind: app-help
screen: autotrade
feature: autotrade-strategies
tags:
  - app-help
  - screen
  - autotrade
  - the
  - autotrade
  - (paper)
  - screen
keys:
  - q
  - ctrl+c
  - 1
  - 2
  - 3
  - 4
  - tab
  - j
  - down
  - k
  - up
  - g
  - home
  - G
  - end
  - pagedown
  - ctrl+f
  - pageup
  - ctrl+b
  - enter
  - esc
  - backspace
  - a
  - v
  - m
  - ,
  - <
  - >
  - ?
  - t
  - p
  - $
  - E
  - w
  - b
  - y
  - x
  - P
  - Z
  - R
  - T
  - K
  - N
  - O
  - U
  - ctrl+w w
  - ctrl+w n
  - ctrl+w tab
  - ctrl+w N
  - ctrl+w s
  - ctrl+w m
  - ctrl+w o
  - ctrl+w d
  - ctrl+r
  - Q
  - n
  - d
  - e
  - c
  - i
  - r
  - s
  - u
  - !
  - f
  - o
actions:
  - quit
  - screen.screener
  - screen.newpairs
  - screen.watchlist
  - screen.analyst
  - screen.next
  - move.down
  - move.up
  - move.top
  - move.bottom
  - move.pagedown
  - move.pageup
  - open
  - back
  - analyst.toggle
  - voice.talk
  - voice.mute
  - voice.cycle
  - voice.rate
  - help.toggle
  - theme.next
  - pause.toggle
  - display.priceMode
  - export.view
  - watch.add
  - alert.propose
  - alert.confirm
  - alert.dismiss
  - screen.positions
  - scan.toggle
  - scan.resume
  - screen.trending
  - social.kol
  - screen.narrative
  - screen.plans
  - screen.follows
  - workspace.list
  - workspace.next
  - workspace.prev
  - workspace.save
  - workspace.morning
  - workspace.popups
  - workspace.default
  - screen.rules
  - screen.autotrade
  - autotrade.view
  - autotrade.new
  - autotrade.dup
  - autotrade.edit
  - autotrade.compare
  - autotrade.backtest
  - autotrade.sweep
  - autotrade.export
  - autotrade.import
  - autotrade.run
  - autotrade.save
  - autotrade.undo
  - autotrade.kill
  - autotrade.pause
  - autotrade.flatten
  - autotrade.proposal
tools:
  - strategy_list
  - autotrade_status
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/screens/overlay.ts
date: 2026-10-16
---

Press `Q` anywhere for AUTOTRADE, paper only. tab cycles five views: STRATEGIES (the presets and your own files with mode, version, hash and the last backtest), EDITOR (one form in six sections: entry, exits, risk, sizing, agent, execution; every change re-validates, errors show inline with their path, the screen filter is checked by the screener's own parser and its error column is marked; `s` saves only a valid draft as a new version, `u` undoes), COMPARE (two marked strategies side by side, changed fields first, both backtested on the same tape), BACKTEST (the report with attribution, an equity sparkline, clamps, refusals and the limits box; `w` runs a sweep whose verdict comes from coins it never tuned on) and RUNNER (the paper runner's heartbeat, halt reason, candidates, sessions, positions and ledger tail). Presets are read-only: `d` makes your own copy. Nothing on this screen switches a strategy to live, arms a mandate or touches a wallet. A strategy edit the analyst proposed in chat shows as a card: `o` opens its diff, `y` applies it, and a LOOSER edit (any risk number less safe) needs a second `y` on the less-safe popup.

Keys on this screen:
  `q/^C` — quit
  `1` — screener
  `2` — new pairs
  `3` — watchlist
  `4` — analyst
  `j/↓` — move
  `k/↑` — move
  `g/home` — top
  `G/end` — bottom
  `PgDn/^F` — page
  `PgUp/^B` — page
  `⏎` — open
  `esc/⌫` — back
  `a` — ask claude
  `v` — voice
  `m` — mute voice
  `,` — change voice
  `</>` — slower / faster voice
  `?` — help
  `t` — theme
  `$` — price ⇄ mcap
  `E` — export PNG + report
  `y` — confirm alert
  `P` — positions
  `Z` — AI scan
  `R` — resume scan
  `T` — trending
  `K` — KOL lists
  `N` — narrative board
  `O` — order plans
  `U` — followed wallets
  `^W w` — workspaces
  `^W n/^W tab` — next workspace
  `^W N` — previous workspace
  `^W s` — save workspace
  `^W m` — morning HUD
  `^W o` — open workspace popups
  `^W d` — default workspace
  `^R` — rules
  `Q` — autotrade (paper)
  `tab` — next view
  `n` — new from preset
  `d` — duplicate
  `e` — edit
  `c` — mark to compare
  `b` — backtest
  `w` — sweep (held-out)
  `x` — export file
  `i` — import file
  `r` — runner
  `s` — save (new version)
  `u` — undo
  `!` — kill (soft stop)
  `p` — pause new entries
  `f` — flatten (confirm)
  `o` — review chat proposal
  `?` — this help
