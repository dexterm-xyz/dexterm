---
id: docs-spectator-the-agent-hud-spectator-v2
title: Spectator view (watch the agent cook) › Follow over MCP in the running terminal › The agent HUD (spectator v2)
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: The agent HUD (spectator v2)
anchor: the-agent-hud-spectator-v2
url: https://dexterm.xyz/docs/spectator#the-agent-hud-spectator-v2
tags:
  - docs
  - spectator
  - agent
  - hud
  - follow
  - over
  - mcp
  - running
  - terminal
  - view
  - watch
  - cook
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/spectator.md
date: 2026-10-16
---

While the terminal follows an MCP agent, it shows the agent working, not a list of calls. The app's own screen renders a few rows shorter, so nothing of it is hidden, and an **agent dock** sits under it:

- **The heartbeat and the phase rail.** A heartbeat trace beats faster as the agent calls more tools. The rail `SCANNING ─ VETTING ─ SIZING ─ EXECUTING ─ HOLDING ─ EXITING` lights the phase it is in. While it holds a position and checks other coins, the rail stays on HOLDING and shows the side activity next to it.
- **The thought ribbon.** The agent's own words, typed in as it thinks, when you pass `--spectate-thoughts FILE` (see below). Otherwise dexterm narrates what each call did, from the call's own numbers ("scanning 12 rows · 3 moving up", "verdict WATCH · rug heuristic 11%").
- **The call timeline.** Each call is a node, newest on the right, spaced by the time between calls. Under each node is a result chip: green for ok, amber for slow, red for a failure or a refusal. PAPER calls are marked.
- **`PAPER` and the controls are always on screen**: **^P** pause, **^K** kill.

Over the screen itself:

- The **rows the agent scans glow**, with a beam sweeping down them. The row it opens gets the **agent cursor** (`▶ … ◀ AGENT`), and the token screen assembles top-down as it opens.
- A **vetting card** fills in the checks the agent ran (price, tape, chart, holders, rug, dev, LARP, verdict). Its **LARP gauge** sweeps to the number of evidence flags `larp_check` found; that number is evidence, not a verdict.
- **The PAPER execution moment** (with `--agent-paper`): an order ticket assembles with the size, your per-trade cap and the gate as it really is (your keypress armed the mandate; inside it there is no keypress per paper trade, and the desk enforces the caps). Then the fill lands with a flash and the entry from the paper fill, and the ticket turns into a **position panel**. That panel shows the mark PnL as a big number with a trace, the peak and the time held. The mark is this terminal's own price for the coin, or the price a tool call returned, never a number the agent typed. Each exit flashes. When the position is flat, a **result card** shows the realized PAPER result, the hold time and the exits.
- **Kill is a hard stop.** **^K** cuts the screen with a red flash and a short glitch, stamps `KILLED`, closes the agent's session and stops its paper desk for the rest of the run. The dock then stays on `AGENT KILLED`. **^P** pauses (the band under the header says so and the screen is framed in amber), and any other key hands the screen to you.

Every number the HUD shows comes from the app: a tool's own result (the rows a scan returned, the verdict, the paper ticket, fill and position, the caps the desk replayed) or this terminal's price. The agent's text is display only: it is scrubbed and clipped, and nothing in it is acted on.

**Motion and colour.** Calm mode (`--calm` or the `C` key) is the reduced-motion setting here as everywhere else. The sweeps, flashes, the glitch and the typing go away, and every card and number appears at once. With `NO_COLOR` the meaning stays in glyphs: `▸` marks the active phase, chips carry `✓ ! ✗`, and the cursor is `▶`. A terminal shorter than 24 rows gets no HUD; the status lines are shown as toasts instead, and the PnL chip moves to the band under the header.

#### The thought ribbon: `--spectate-thoughts FILE`

dexterm cannot see inside your agent, so its words come from a file the agent writes. Pass `--spectate-thoughts FILE` (with `--spectate-mcp`). The file can be:

- Claude Code's stream output (`claude -p --output-format stream-json --verbose … > FILE`): text and thinking blocks;
- a JSONL file with `{"thought": "…"}` lines.

The file is tailed for display only, and each line is scrubbed: control and bidirectional characters are removed, addresses are masked and markdown is dropped. One message becomes one short line.
