---
id: docs-overlay-set-it-up-in-obs-step-by-step
title: Streamer overlay (OBS) › Set it up in OBS, step by step
kind: docs
page: overlay
page_title: Streamer overlay (OBS)
heading: Set it up in OBS, step by step
anchor: set-it-up-in-obs-step-by-step
url: https://dexterm.xyz/docs/overlay#set-it-up-in-obs-step-by-step
tags:
  - docs
  - overlay
  - set
  - obs
  - step
  - streamer
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/overlay.md
date: 2026-10-16
---

1. Start the session you want to show (see above).
2. In a second terminal, run:

   ```sh
   $ dexterm overlay --theme cyberspace
   dexterm overlay · theme cyberspace · each URL works once, for 10 min
     activity  http://127.0.0.1:53133/overlay/activity?p=…
     coin      http://127.0.0.1:53133/overlay/coin?p=…
     pnl       http://127.0.0.1:53133/overlay/pnl?p=…
   ```

   Leave it running for as long as you stream. `q` (or ctrl+c) stops it.
3. In OBS, in your scene's **Sources** panel, click **+** and choose **Browser**. Name it (for example "dexterm coin") and click **OK**.
4. In the properties window:
   - **URL**: paste one of the printed URLs (the whole line after the scene name).
   - **Width / Height**: `1240` × `420` for `coin` or `activity`, `1240` × `760` for `pnl`, `1600` × `1300` for `all`. Resize the source on the canvas afterwards; the scenes scale.
   - Leave **Use custom frame rate** off.
   - Leave **Custom CSS** as OBS fills it in (it keeps the background transparent) or empty.
   - Untick **Shutdown source when not visible** and **Refresh browser when scene becomes active**: either one reloads the page, and a reload needs a fresh URL (see below).
5. Click **OK**. The panel appears over your stream with a transparent background. Repeat steps 3 to 5 for the other scenes.
6. To check the setup without a live agent, run `dexterm overlay --replay session.jsonl --loop` and watch the scenes fill in with the SAMPLE DATA tag on.

**Each URL works once.** It is a single-use ticket: OBS's first load spends it, and the page then holds its own one-time connection. If OBS reloads the page, or you paste the URL into a second source, the page stays empty. Press **n** in the overlay's terminal for a fresh set of URLs and paste the new one into the source. URLs that are never loaded expire after 10 minutes (`--ticket-ttl MIN` changes that, 1 to 240). When you restart `dexterm overlay`, its port changes too, so paste fresh URLs then; `--port N` keeps the port fixed (the tickets still change).
