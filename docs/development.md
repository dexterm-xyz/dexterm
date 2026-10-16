# Development notes

This page is the maintainers' working reference for running, testing and extending dexterm from a checkout. It was carried over from the internal app README at c289d90 and still mentions internal task ids (`task-NNNN`); those are tracking numbers, nothing more. The user-facing guide is the [README](../README.md).

## Layout

npm workspaces, TypeScript (strict, ESM). Node 22.18+ runs the sources directly with
built-in type stripping; no build step is needed for development.

| Package | Role |
|---|---|
| `packages/agents` (`@dexterm/agents`) | bring-your-own-agent layer (task-1345): per-agent identity and session tokens, server-side capability tiers (observe / annotate / propose), the gate every agent call passes, rate limits and quotas, proposals, the audit log, the loopback agent bus and the TS SDK. No agent path can arm, sign, raise a cap or change the gate. |
| `packages/cli` (`dexterm`) | terminal DEX screener with a local Claude CLI analyst |
| `packages/custom` (`@dexterm/custom`) | customization layer (task-1358, from the task-1288 design): versioned config.json (no secrets, ever), the layout solver + named workspaces, user themes, keymap overrides, the rules engine (parsed, never eval'd; alerts + PROPOSALS only), shareable packs (hash lock + ssh signature; never executes pack code) and the popup widget API. Zero runtime dependencies. |
| `packages/data` (`@dexterm/data`) | data layer: normalized model, source adapters, cache, rate limiter, health registry (SPEC §3) |
| `packages/mcp` (`@dexterm/mcp`) | read-only MCP server over stdio (SPEC §5, D-09). |
| `packages/packs` (`@dexterm/packs`) | AI analysis suite (task-1356, AI-SUITE-DESIGN): analysis packs (token/wallet dossier), narrative board, watchlist/new-pair digests, rug-probability model + honest backtest, replay-based backtest harness. Facts come from tools or recorded history, never model memory; every model stage is labelled output with data ages; untrusted text is firewalled. |
| `packages/popup` (`@dexterm/popup`) | popup host: loopback-only server + frameless HUD windows (wry) with graceful browser fallback (task-1290) |
| `packages/recorder` (`@dexterm/recorder`) | history recorder (AI-SUITE-DESIGN §4, lane R-01): snapshot-on-change from the data layer, feed membership, outcome sweeps, code-only labels, retention, export for the eval |
| `packages/tui` (`@dexterm/tui`) | terminal renderer: cell buffer, diff flusher, widgets, themes, breakpoints, keymap (SPEC §2.2, §7) |
| `packages/voice` (`@dexterm/voice`) | JARVIS voice mode (task-1282): push-to-talk, local no-key speech-in, macOS say speech-out, a safe deterministic router. Voice never executes a trade. |

## Run

```sh
npm install                                             # dev tooling only (typescript, @types/node)
npm run dexterm                                         # interactive, live keyless data (TTY); cyberspace look, fever intensity
npm run dexterm -- --fixtures                           # interactive demo on seeded fixtures (demo event keys below)
npm run dexterm -- --calm                               # neon theme, no rain / glitch / blink / scanlines (DEXTERM_CALM=1 too)
npm run dexterm -- --intensity normal                   # 15 fps, sparser rain, no idle aberration
npm run dexterm -- --fps 15 --no-boot                   # cap the frame rate; skip the boot sequence
npm run dexterm -- --screen token --mint <MINT> --width 176 --height 48   # one live token frame (Helius holders when the key is configured)
npm run dexterm -- --screen newpairs --listen 30 --width 176 --height 48  # listen to PumpPortal for 30 s, then render
npm run dexterm -- --screen watchlist --width 176 --height 48             # the persisted watchlist with live prices
npm run dexterm -- --screen screener --width 176 --height 48                       # one live frame (≈5 requests)
npm run dexterm -- --screen screener --filter "vol24 > 250K liq > 50K" --sort liq  # filter grammar + sort
npm run dexterm -- --screen screener --record /tmp/rec.json --max-requests 10      # live frame, saved for replay
npm run dexterm -- --screen screener --replay /tmp/rec.json --width 120 --height 40 # same frame, no network
npm run dexterm -- --screen token --fixtures --width 176 --height 50 --frame 41 --event pump --ai streaming:120 --ansi
npm run dexterm -- --screen boot --fixtures --t 0.78 --frame 30 --plain            # the boot screen at 78 %
npm run dexterm -- --screen newpairs --fixtures --color 256 --ansi        # 256-color fallback
npm run dexterm -- --no-images                                            # coin images off (DEXTERM_IMAGES=0 too; see "Coin images")
npm run dexterm -- --screen screener --color 256 --html /tmp/s.html       # a Terminal.app-faithful (256-colour) HTML frame
NO_COLOR=1 npm run dexterm -- --screen watchlist --fixtures --ansi        # attributes only (and calm by default)
npm run dexterm -- --help
```

Screens: `screener | token | newpairs | watchlist | analyst | boot`. The screener runs on the data
store (`@dexterm/data`: DexScreener + Jupiter, keyless) by default; `--fixtures` keeps the seeded
demo, `--replay FILE` serves a recording made with `--record FILE` (a recording also carries the
PumpPortal session, so new pairs replay too). `DEXTERM_OFFLINE=1` refuses live data (tests, CI).

### What is live and what is still demo (task-1298)

| Screen | Live | Source(s) | Still demo |
|---|---|---|---|
| Screener | yes | DexScreener + Jupiter | – |
| Token (⏎ on any live row, or `--mint`) | yes | market: DexScreener + Jupiter · candles + trades tape: GeckoTerminal · mint/freeze authority + top-20 holders: **Helius** (key) with the public RPC as fallback · RugCheck summary · GoPlus second opinion · **snipers / bundled from the wallet-intel scan** (task-1340, Helius history; keyless says `needs Helius key`) · **ANALYST panel: your local `claude` CLI** (task-1302) | dev history says `needs Helius key` |
| New pairs | yes | push: **PumpPortal** `subscribeNewToken` + `subscribeMigration` (free, one connection, reconnect with backoff) · polls: Jupiter `recent` (15 s), RugCheck `new_tokens` (30 s), DexScreener + Jupiter for the visible rows (10 s) | SNIPE / BUNDLE columns + spotlight rows come from the wallet-intel scan of the row the cursor rests on (~2 s dwell, Helius-keyed only; task-1359); unscanned rows dash, keyless says `needs Helius key`; the `✦ claude` line in the spotlight is labelled demo |
| Watchlist | yes | SQLite (`--db`, default `~/.local/share/dexterm/dexterm.db`), prices via DexScreener + Jupiter every 10 s | the analyst digest (one labelled line) |
| Analyst | yes | **your local `claude` CLI** streaming a dexterm skill over the read-only `dexterm mcp` tools (task-1302) | the demo transcript shown only until you trigger a run (`⏎` on a token, or `a`) |

Every live source goes through the health registry: a panel whose source is down shows `unavailable: <reason>`
or `needs key`, never a number. Bonding progress on new pairs is estimated from the curve's virtual reserves at
create time (pump.fun `Global` config constants) and says so.

#### Two-speed feed: a FAST lane for what you are watching (task-1312)

dexterm runs two lanes into the same model (SPEC §3.9). The **slow lane** is the polling screener above
(DexScreener/Jupiter/GeckoTerminal, ~10 s, hundreds of tokens). The **fast lane** is *push*: the open token
and your watchlist are priced in real time from on-chain state — one shared WebSocket `accountSubscribe`
on each token's pump.fun **bonding-curve account**, price computed on-chain (no aggregator), sub-second.

- **LIVE vs POLL badge** (honest): the token price, each watchlist row (`FEED` column) and the new-pairs
  spotlight show **LIVE** only while a fresh on-chain push is actually flowing for that token; otherwise
  **POLL** — the stream is down, the token is not a pump.fun curve, it has migrated to a DEX pool, or it is
  past the fast-lane cap. A LIVE row shows the on-chain curve price; a POLL row shows the polled price.
- **Cap:** at most **24** simultaneous fast-lane subscriptions (open token + a 5–20 watchlist + a few fresh
  launches). Chosen for the free tier — one connection multiplexes them, each fires only on an account
  change, the Helius credit meter bounds spend, and the keyless public RPC WS has tight limits. Tokens past
  the cap stay on the slow lane (POLL), never dropped.
- **Free-forever:** keyless, the fast lane uses the **public RPC WebSocket**; a free Helius key only makes it
  faster (lower latency, higher limits) and is used first when present. On Helius-credit exhaustion it drops
  to the keyless public RPC automatically; if no stream is available it falls back to the slow polling lane.
- **Idle cost:** the fast lane adds **zero** HTTP requests/min (it is push); price pushes never force a draw
  in `--calm` (the 2 Hz tick picks them up) and are throttled in normal mode, so idle CPU stays bounded.

**COMING (labelled in-app, not live yet):** dev-history (`needs Helius key`; snipers / bundled are live from the
task-1340 scan on the token screen and, since task-1359, on the new-pairs row the cursor rests on); the one-line analyst digests on the watchlist and in the
new-pairs spotlight (labelled demo until you run the analyst yourself). Nothing in this list fabricates a
number — each shows a dash, `needs key`, or a *demo* label until the real source lands.

### After-launch analysis suite (task-1356)

Built on the two-stage analysis packs (deterministic ASSEMBLE, 0 tokens; the optional REASON stage may only
*tighten* a verdict, never invent facts):

- **Rug-probability model.** Every token dossier can carry a `rug_probability` with its `rug_model` id and the
  age of the data it read. The shipped default is **`H1-v0.1`** — a *pre-registered additive heuristic*, not a
  learned model. dexterm does not ship a trained model until the recorder has ~2 weeks of labelled outcomes;
  the backtest harness below is how a v1 logistic model would be judged honestly before it replaces H1.
  **First backtest on real history (task-1361, 2026-10-12, this machine's recorder, keyless-proxy labels):**
  at 1 h, n = 401 observed outcomes with 22 positives (rug ∪ dead): AUC 0.78, precision 9 % / recall 27 % at the
  0.5 flag line, Brier 0.152 against a base-rate Brier 0.052. So H1 *ranks* tokens somewhat but its probabilities
  run far too high (rows scored 0.8–1.0 rugged 0 % of the time, n = 25; 0.4–0.6 → 16 %). Two days from one
  machine, mostly the top-trending feed: treat these as the first reading, not a result. Re-run with
  `dexterm backtest` as history grows.
- **P(RUG) screener column** (task-1361): the screener shows H1's p(rug) per row, labelled as a model output —
  the panel caption says `p(rug) = H1-v0.1 heuristic`, the spotlight repeats the value with the model id and the
  age of the scored data, `—` when nothing is scoreable, `rug` is a sort key (safest first). Given the
  calibration above, read it as a ranking, not a probability.
- **One-line digests** (`model_output: false`): a deterministic `VERDICT [p(rug) NN%] · <highlights>` ≤ 90 chars,
  surfaced by `analyze_token` (MCP) and reusable on the watchlist / new-pairs spotlight.
- **`dexterm backtest`** (`--subject heuristic|pack_verdicts  --horizon SEC  --db PATH  --json`) scores a subject
  against the recorder's outcome-labelled snapshots and prints **honest** metrics — precision/recall, Brier vs a
  base-rate Brier, AUC, calibration, per-feed breakdown, and the worst misses / false alarms — with leakage
  checks (features from t0 only, labels strictly after t0). With no labelled outcomes it says so and prints **no**
  metrics rather than fabricating any.
- **LARP eval** (task-1359): every settled LARP-detector verdict (`product_assessment`) is now written to the
  recorder's `verdicts` table (pack `larp-check`), and `dexterm backtest --subject larp` joins those verdicts to the
  outcome labels (latest t0 anchor ≤ 10 % of the horizon before the verdict; later anchors never match) and reports
  counts per verdict class, a LARP-vs-real confusion matrix and, only once ≥ 50 verdicts are matched, P(bad | LARP),
  P(bad | real) and P(LARP | bad) with 95 % Wilson intervals. It measures agreement with a bad price outcome, not
  whether a product is real. **Measured 2026-10-12:** 0 LARP verdicts recorded (the recorder never stored them
  before this change), labelled history n = 149 observed 1 h outcomes in the research DB and n = 0 in this
  machine's app DB, so no accuracy figure exists yet. **Re-measured after the task-1361 recorder fix (same day):**
  the app DB now holds n = 401 observed 1 h outcomes, but still 0 LARP verdicts (a verdict is only written when
  you run the LARP check on a token), so the LARP figure is still n = 0 and `larp-quality` stays in progress.
- **Recorder maintenance actually runs** (task-1361): the outcome sweeps and labels never fired in two days of
  use (0 `sweeps`, 0 `outcomes` rows) because the first maintenance pass waited 60 s after launch and nothing ran
  at quit, and every real run had been a ≤ 14 s smoke/capture run. Now the first pass runs 5 s after launch
  (`RECORDER_FIRST_TICK_MS`), then every minute, and `Recorder.close()` labels what is due. Regression tests in
  `packages/recorder/test/schedule-1361.test.ts`; `dexterm recorder label` clears an older DB's backlog at once.
- **Screener presets.** **Graduating** now ships as a *keyless approximation* (an mcap-band proxy for a
  bonding-curve launch nearing graduation, labelled `approx` in the preset bar so the UI never implies the keyed
  bonding-% signal; it swaps to the real column when a launch source is keyed). **Smart money** stays gated on a
  top-traders key and says `needs key`, because a "smart money" preset without wallet-PnL data would mislead.

### Wallet intel, the bubble map and trade moments (task-1340)

**Holder classes (task-1367).** Every top holder is classed from the chain by `packages/data/src/intel/holder-class.ts`:
POOL / CURVE / VAULT / LOCK / CEX / BURN / DEV / LINKED, or UNLABELLED with what is known (never a guess; an
unknown program is counted, not hidden). Inputs are the token account's owner and the owner account's program, both
already fetched by the scan; the constant pool-authority PDAs are re-derived in `packages/data/test/holders-1367.test.ts`.
The token screen shows the class on each HOLDERS row, `Top 10 ex-pool` (no POOL/CURVE/VAULT/LOCK/BURN owners; the
colour reads it) next to `Top 10 raw`, and a `⚠ main risk` line when a counted owner holds more than 30 %. Lock
unlock schedules are not decoded yet (the escrow and program are shown). Snipers / bundled name the real reason a
launch window is missing (`needs Helius key` only without a key; `Helius paused · r`, `Helius cap today`,
`history failed · r`), and `r` retries.

`M` on a token opens the **BUBBLE MAP** (`packages/cli/src/screens/bubbles.ts` over `packages/tui/src/bubbles.ts`):
the top holders as packed half-row discs, area = share of supply, colour = the RULE that labelled the wallet (dev,
bundle, linked, sniper, pool/LP, exchange, unlinked), rings + tags for linked clusters, a CLUSTERS table,
sample-captioned HOLDER INSIGHTS and a WHY THIS LABEL panel (rule · confidence · evidence). The rules live in
`packages/data/src/intel/rules.ts` (P1 D1 R1 R1b R2 R3 R4 R5 S1 F1 X1 L0, ported from the task-1286 spike and
replay-tested against its three recordings); `intel/helius-history.ts` is the Helius-only `getTransactionsForAddress`
adapter (funders cached forever, launch windows 30 days); `intel/scan.ts` runs the two tiers (light on token open,
deep for watched coins / `D`) through the limiter, health registry and credit meter. Keyless the map still draws
from the public RPC holder list with static labels and says a free Helius key adds funders + the launch window;
no ranked list → `unavailable` with the fix. Exchange labels are a typed seed list and read **unverified**;
cabal-class labels are hidden by default (`HIDDEN_LABELS`). `M` on the bubble screen opens the same graph as real
circles in a loopback-only popup (`packages/popup/src/pages/bubbles.*`): hover = rule, click = select (the
terminal follows), `m` treemap, `z` zoom.

**Trade moments** (`packages/tui/src/fx-trade.ts`, `sound.ts`): buy shockwave, profit gold burst, loss static
collapse, failed lockout flicker, an in-flight scanning sweep. The ONLY producer is `LiveContext.onSettled`, which
the ticket binding calls once per settled outcome (booked paper fill, confirmed live fill, refusal, send failure;
never a quote, a plan or a `send-unknown`); `fireMoment` throws on anything that is not confirmed/failed. The
ticket is **shielded** (`Canvas.shieldRect`): no effect pass can write into it (tested byte-identical vs calm).
`--sound` / `DEXTERM_SOUND=1` adds synthesized cues (WAVs in `~/.dexterm/sounds`, played detached); muted by default.

### FREE-FOREVER: every feature works with zero paid keys (task-1309)

dexterm must be usable indefinitely as your DEX with **no paid data and no shipped keys** — Node, a terminal
and your own `claude` login are enough. Paid or user-supplied free keys only raise speed/limits or unlock depth;
they never gate a feature. Each data need has a keyless path and degrades honestly:

| Data need | Keyless source (no key) | Free-key upgrade (what it adds) | Per-user limit | Without it |
|---|---|---|---|---|
| Screener pool | DexScreener + Jupiter Tokens v2 | Jupiter free key via portal → 1 rps (from 0.5) | your IP's DexScreener 300/min, Jupiter ~30/min | — (fully keyless) |
| Token market | DexScreener + Jupiter | Jupiter free key: higher rate | per-IP | — |
| Candles / chart | GeckoTerminal | — | ~10/min per IP | chart `unavailable` (rare) |
| Trades tape | GeckoTerminal | Helius/Birdeye: richer, labelled flow | ~10/min per IP | tape `unavailable` |
| Mint/freeze authority | public Solana RPC (`getAccountInfo`) + Jupiter + GoPlus | any free RPC: faster, fewer 429s | per-IP RPC throttle | Jupiter/GoPlus still answer |
| **Top holders** | **Jupiter aggregate: holder count + top-10 % concentration** | **any free RPC key** (Helius/Alchemy/QuickNode/Ankr) → the ranked **top-20 list with owners** | per-IP/credits | count + concentration shown; ranked list says "needs a free RPC key" |
| Security checks | RugCheck + GoPlus (both keyless) | — | undocumented, paced | one may be `unavailable`, the other covers |
| New pairs stream | PumpPortal (`subscribeNewToken`/`subscribeMigration`) + Jupiter `recent` poll | Helius `programSubscribe`: live per-curve bonding % | per-connection | rows from the poll; bonding is a create-time estimate |
| Watchlist prices | DexScreener + Jupiter, persisted in SQLite | Jupiter free key: higher rate | per-IP | — |
| Fast-lane live price (open token + watchlist) | public RPC WebSocket `accountSubscribe` on the pump.fun bonding curve, price computed on-chain | free Helius key: lower latency, higher limits (used first) | per-connection; cap 24 subscriptions | falls back to the polled price (POLL badge) |
| Dev history / snipers / bundled | — (keyless cannot see wallet history) | Helius (wallet-intel scan: token open + the selected new-pairs row) | credits | columns dash + `needs Helius` |
| Wallet intel | — | Helius | credits | later card |

**Why a local client scales:** every free source meters by **your** IP/key, so each user has their own quota —
there is no shared server bottleneck.

**The ranked holder list is the one real keyless gap.** `getTokenLargestAccounts` is throttled (official RPC
429s it per-IP) or blocked (PublicNode 403) on every keyless endpoint we probed (2026-10-07), and
Birdeye/Solscan need keys. So keyless the holders panel shows **holder count + top-10 % via Jupiter**; the
per-wallet ranked list needs a free RPC key (2-minute signup, no card). Configure one of:

```sh
# Helius free (1M credits/mo): save the key ONLY here (never a repo, never a command line):
printf %s "<your-key>" > ~/.dexterm/helius.key && chmod 600 ~/.dexterm/helius.key
# …or any read-only RPC URL(s) — the first wins, extras join the rotation pool:
export DEXTERM_RPC_URL="https://<provider>/<path>"        # Alchemy / QuickNode / Ankr free tier
export DEXTERM_RPC_URLS="https://rpc-a/...,https://rpc-b/..."  # extra free endpoints (comma-separated)
```

**RPC pool (`@dexterm/data` `rpc-pool.ts`).** All configured endpoints (your key first, then the keyless public
seed list) go into a pool that rotates by health score, pauses an endpoint on a 429 (honouring `Retry-After`,
else a doubling backoff) and fails over to the next — each endpoint on its own rate bucket, so one endpoint's
pause never stalls the others. **Request budget meter (`budget.ts`)** counts every request per source (this
session and today, persisted in SQLite) so usage is visible; optional soft daily caps bound a source. The
**persistent SQLite cache** (TTLs in `cache.ts`) makes a restart or reopen instant and cheap.

Keyless proof: `DEXTERM_LIVE=1 HOME=$(mktemp -d) node packages/cli/scripts/smoke-1309.ts` runs the screener,
token (authorities + keyless holder aggregate), new pairs and watchlist with no key and prints a PASS per
feature, the pool status and the budget.

### Jarvis voice mode (task-1282, task-1339; macOS)

`v` is push-to-talk: press, speak, press again to send. A red `● LISTENING` badge sits on row 1 the whole time
the mic is live; `m` mutes replies, `,` cycles the macOS voice, `esc` stops a reply or cancels the mic, and any
other key closes the mic first and then does its job (the mic also auto-closes after 15 s). Free and local by
rule: speech-out is the built-in `say`; speech-in is on-device Apple Speech (a helper compiled once with
`swiftc` into `~/.dexterm/voice-helper`) or a local whisper.cpp `base.en` model; the only model in the loop is
your own `claude` login, for analysis questions. No paid speech API, no key, nothing recorded
(`DEXTERM_VOICE_RECORD=1` keeps the whisper WAV). `dexterm doctor` has a warn-only voice section; off macOS
voice is off and every voice action has a key.

- **Instant path (no model):** "show me the runners", "open bonk", "filter liquidity over 50k", "watch this
  one", "show the chart" / "close the chart" (the popup host), "buy bonk" / "sell half of wif" → a **PAPER
  ticket in its editing phase** for the spoken coin. Router + `say` measured under 1 ms after the transcript.
- **Analyst path:** questions ("is this a rug?") go to `claude`; the first two sentences are read back.
- **Clarifies, never guesses:** unknown ticker, copycat ticker (two mints, one symbol), homophone ("cell wif"),
  pronoun on an empty list, screen command + trade in one breath, bare "close"/"exit" → a spoken question.
  A named ticker always beats "it".
- **Proposals only (ROADMAP hard rule):** voice can never confirm, sign, flip a ticket to LIVE, arm a plan,
  raise a cap, panic or run `/wallet …`. The router's output is a closed set of kinds; `isSafe()` rejects any
  decision carrying a mode/live/arm/caps/confirm/sign/send field; the voice keys are off on the ticket screen;
  `packages/cli/test/voice-1339.test.ts` drives the real key loop with the executor, both confirm paths, the
  LIVE flip and the wallet commands booby-trapped (21 hostile utterances in-app, 0 touches; the router
  battery in `packages/voice/test/` adds more). A ticker that collides with a command word ("buy live"),
  more than one ticker in a breath ("buy wif and bonk") and a spoken size/slippage ("buy 10 sol of bonk")
  all clarify rather than open a silent ticket for the highlighted row.
- **Latency:** `node packages/voice/tools/voice-bench.mjs [--real-claude] [--recompile]`.
- **Env:** `DEXTERM_VOICE_STT=auto|apple|whisper|fake|none`, `DEXTERM_VOICE_TTS=auto|say|fake|none`,
  `DEXTERM_WHISPER_MODEL`, `DEXTERM_VOICE_HELPER_DIR`, `DEXTERM_SWIFTC`.
- **Unverified:** a person's first-launch Microphone + Speech prompts and a real spoken end-to-end pass.

### The Claude analyst (task-1302)

The ANALYST panel (and the full `a` screen) spawn **your own `claude` CLI** — no API key is shipped; your
subscription/billing and model default apply. It runs a versioned dexterm skill (`token-dossier`, `rug-check`,
`trench-scan`, built in task-1293) against the **read-only** `dexterm mcp` server, which exposes the same data
adapters the TUI uses plus the 17-entry knowledge base (`kb_lookup`/`kb_search`) and case files (`case_lookup`). Both the skills and the KB
can be overridden or extended from `~/.dexterm` (`dexterm kb|skill …`, see Customization).

- **`⏎` on a live token** → a full `token-dossier`; **`a`** → a `rug-check` on the selected token, or a
  `trench-scan` of the screener when nothing is selected. The verdict and tool-call lines are coral, the answer
  decrypts in, and the caption shows cost · latency · tools · model.
- **Facts come only from tools.** The analyst system prompt forbids token facts from memory; every number is
  grounded in a tool result with its source and age. Token names/descriptions/RugCheck text pass the prompt
  firewall (`<untrusted>`); prompt-injection in token text is flagged, never followed.
- **Read-only, always.** No tool can build, sign or send a transaction. Alerts/notes/watchlist adds are
  *proposals* the panel shows; you confirm them with a keypress (the model never writes).
- **Degrades cleanly.** If `claude` is missing or logged out the panel shows a one-line fix
  (`npm i -g @anthropic-ai/claude-code && claude login`) and the rest of dexterm keeps working.
- **Standalone server.** `dexterm mcp` is a plain stdio MCP server; add it to any Claude Code with
  `claude mcp add dexterm -- node packages/mcp/bin/dexterm-mcp.mjs`. (It runs its own in-memory data layer;
  sharing the TUI's live cache over a socket is a later card.)

**RPC and the Helius key.** `DEXTERM_RPC_URL` wins; else `~/.dexterm/helius.key` (mode 600, outside every repo) is
read *in code* and the Helius URL is built in memory; else the public RPC (holders usually 429 there). The key is
never printed: every URL in an error, a `--verbose` line or a `--record` file goes through `redactSecrets()`,
replay matches with the key redacted, and `FixtureStore.save()` refuses a file that still carries one.

**Credit meter.** Helius Free is 1M credits a month, budgeted as 33,333 a day. Each Helius request is charged
(1 credit for standard RPC methods, 10 for DAS-class); the header shows `◐ helius credits N%` from 50 % of the
day and at 90 % (or the per-run cap, `--max-credits`, default 5000) Helius switches off for the run and the
keyless sources take over. Day totals persist in the SQLite DB, so a restart keeps counting.

Keys on the live screens: `⏎` opens the token detail from any row, `w` watches/unwatches the highlighted token
(screener, new pairs, token screen), `b` proposes a liquidity alert, `y` arms the oldest proposal, `x` dismisses
it, `d` removes a watchlist row, `1`–`6` switch the token chart's timeframe, `r` refreshes. Alerts are proposals
until `y` confirms them; armed rules fire once into the ALERTS log. Nothing here trades.

```sh
DEXTERM_LIVE=1 node packages/cli/scripts/smoke-1298.ts --ws-seconds 45   # live smoke: ≤25 requests, one 45 s PumpPortal session, prints event→row/frame latency
DEXTERM_LIVE=1 node packages/data/scripts/record-1298.ts --ws-seconds 60  # re-record fixtures/task-1298-sample.json (key redacted at capture)
npm run dexterm -- --screen newpairs --replay packages/data/fixtures/task-1298-sample.json --db :memory:   # offline replay of the recorded session
```

Keys: `1`–`4` screens, `tab` cycle, `j`/`k` or arrows move, `⏎` open (the analyst starts thinking,
then its answer decrypts in), `esc` back, `a` analyst, `t` cycle theme (cyberspace → midnight →
ember → paper), `c` toggle calm, `p` pause, `q` quit. Any key skips the boot sequence or a blink.
Screener keys: `/` filter editor (`vol24 > 250K liq > 50K age < 30d org >= 60 launchpad:pump
!flag:mint cat`; errors show inline with the column), `s` sort menu (enter on the current key
flips direction), `[` `]` presets (Trending, Runners, Organic; Graduating ships keyless as an `approx`
mcap-band proxy, Smart money needs a Tier-1 key and says so), `r` refresh, `g`/`G` top/bottom. The table refreshes every
10 s through the limiter; cells whose source is down show `—` and the panel caption names the
column and the reason (`holders, org: degraded`). Safety checks the keyless sources cannot answer
render `○ … needs key`, never a pass or a fail.
Demo event keys on `--fixtures`: `n` new pair (datamosh + stutter + shake), `u` pump (gold rain,
PUMPING band), `d` dump (red-shifted rain), `x` rug flag (full glitch).

## Coin images (task-1326)

Every row in the screener, new pairs and watchlist carries the coin's picture as a 2-cell icon (dropped
silently when the frame is too narrow), the token screen shows an 8×4 hero at the left of its header and the
screener's spotlight card a 6×3 one; the chart popup shows a 16 px image in its title strip.

- **Real pixels** in terminals with an inline-image protocol: **kitty graphics** (kitty, Ghostty, WezTerm,
  Konsole), **iTerm2 inline images** (iTerm2), **sixel** where the terminal advertises it. At startup dexterm
  sends one short capability query to the tty (a kitty probe, a cell-size request and DA1; ≤ 150 ms, replies
  parsed off the input) and picks the richest protocol the terminal actually answers.
- **Everywhere else — including Apple Terminal.app, tmux and screen — block art**: the image sampled into
  `▀` half-blocks (hero) or quadrant blocks (row icons), and on a 256-colour terminal dithered into the xterm
  cube so round logos keep their disc. Not a photo, but recognisable at a glance; `dexterm doctor` has a
  **Coin images** line that says which path you get and how to get the real thing (Ghostty or iTerm2).
- **Placeholder, never an error**: while an image loads, when a coin has none, or when a host is down, the
  cell box shows the ticker's initial on a colour hashed from the symbol.
- **Off switch**: `--no-images`, `DEXTERM_IMAGES=0`, or `~/.dexterm/images.json`:

  ```jsonc
  { "enabled": true, "blocks": "half", "protocol": "auto", "thumbMax": 96, "diskMb": 32, "replay": false }
  // blocks: "half" | "quad" (hero fallback) · protocol: "auto" | "kitty" | "iterm" | "sixel" | "blocks" (DEXTERM_IMAGES=<protocol> too)
  ```

  `--replay FILE` / `DEXTERM_OFFLINE` runs have no network, so images there could only come from the cache:
  they stay off unless `"replay": true` or `DEXTERM_IMAGES=1`, and recordings keep rendering exactly as recorded.
- **Images never block a frame.** A screen asks the image service synchronously; unknown URLs are queued
  (the rows on screen and the open token first), fetched by a small pool, decoded in a **worker thread** and
  painted on the next redraw. Kitty placements survive text redraws; iTerm2/sixel images are re-emitted only
  on the rows the diff flusher rewrote; every placement is deleted on a screen change and freed on quit.

### Privacy and safety of coin images

Fetching a coin's picture contacts the host that serves it (DexScreener's image CDN for most coins, otherwise
whatever URL the token's metadata points at — an IPFS gateway, a project's own site). dexterm therefore
**fetches through its own local cache, once per image**, and the chart popup is served the cached copy from
the loopback server — a third-party image host never sees a popup load, and a coin seen before is never
fetched again (`~/.local/share/dexterm/images/`, LRU-capped at 32 MB, our own re-encoded PNGs only). If you
do not want any image host to see your IP, run with `--no-images` (or `"enabled": false`): nothing else
changes. Image bytes are treated as hostile: the format is sniffed by **magic bytes** (never the URL or the
Content-Type), size and dimension caps are enforced before a pixel buffer exists (2 MiB, 2048², 4 MP), and
decoding is pure TypeScript (PNG, baseline + progressive JPEG, GIF first frame; WebP is recognised and
refused) — no native decoder, no system library, nothing executes. The fetch follows the LARP detector's
SSRF rules (http/https only, no credentials, every hostname resolved and private / loopback / link-local /
CGNAT ranges refused, redirects re-validated hop by hop, 8 s budget). DexScreener's CDN is asked for a 128 px
rendition instead of the 800 px original. Failed URLs are remembered for 6 h so a dead IPFS link is not hammered.

## The cyberspace look (task-1297, VISUAL-V2)

- **Theme tokens.** `cyberspace` is the default; midnight / ember / paper keep working with quiet
  effect tokens. Every theme carries `rain` / `rainPump` / `rainDump` ramps, `magenta`, `cyan`,
  `coral`, `acid`, `glow`, `scan` and `logo`.
- **Two masks on the cell buffer.** `put()` marks data glyphs *hard*; effects write through `putFx()`,
  which refuses hard and non-blank cells, so **no effect can overdraw a number by construction**.
  Rain additionally needs a *zone* (header band, gutters, the space under the last table row, the
  blank part of every panel, the footer) that screens and widgets opt into. `tools/contrast.mjs` and
  `test/fx.test.ts` prove it (hard cells byte-identical between calm and effects renders; every
  numeric cell ≥ 4.5:1 with effects on).
- **Passes** (`applyFx`, deterministic per `--frame`): seeded rain made of the user's own tickers,
  mint prefixes and tx tails (plus katakana/hex), phosphor trails, chromatic aberration on headings,
  datamosh blocks, whole-frame shake, CRT scanlines. Events (`pulse`): new pair, rug, pump, dump.
- **Market → rain.** Colour and speed come from the data: on the token screen the selected token's
  candles (gold ramp on a pump, red on a dump), elsewhere the rows on screen (5 m deltas plus volume
  velocity on live rows), EMA'd every data tick.
- **Blink** (≤ 350 ms at any cap) on every screen change, **decrypting analyst** with the Claude Code
  spinner, **boot**: the first launch is the full glitch boot, later launches a one-second boot;
  `~/.dexterm/state.json` remembers (`DEXTERM_HOME` overrides the directory, `--no-boot` skips).
- **Intensity tiers.** `fever` (default, 30 fps), `normal` (15 fps, sparser rain, no idle
  aberration), `off` = calm (`--calm`, `DEXTERM_CALM=1`; `NO_COLOR` implies it). Rendering stays
  row-diff flushed; blink and shake frames are wrapped in DEC 2026 synchronized output.
- **Fallbacks.** `--color 256` approximates the ramps; `NO_COLOR` keeps bold/dim only; a non-UTF-8
  `LANG` (or `--ascii-rain`) swaps the katakana for hex.

Color depth is detected from `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, `TERM`, `TERM_PROGRAM`
(`--color truecolor|256|none` overrides). Non-TTY stdout prints plain text unless `--ansi`, which
on a pipe means 24-bit colour (`NO_COLOR` still wins, `--color` still overrides).
The fixture clock is pinned to America/New_York so frames are identical on every machine
(`--tz ZONE` or `--tz local` to change); replays pin it to the recording.

## Test

```sh
npm test            # tsc typecheck + node:test (tui unit + fx tests, CLI tests, snapshots, fx practicality rules, contrast gate, boot state, loop)
```

Snapshot goldens live in `packages/cli/test/snapshots/` and are the **calm** render of this
renderer (`npm run snap:update` regenerates them after an intentional change; say so in the pull request).
When the internal v2 prototype is present (maintainers only), token / new pairs / watchlist / analyst are compared byte for
byte against `prototype-v2 --calm --theme midnight` (plain and 24-bit ANSI, allowing only the coral
rule on the analyst's lines); the screener's column set is compared against both prototypes.
The three `screener-live-*` goldens render the screener over the recorded data-store sample
(`packages/data/fixtures/live-sample.json`).

Tests never touch the network: the CLI tests block `fetch` and replay the recorded sample; the
loop tests point `DEXTERM_HOME` at a temp dir so no test touches the real state file.
The coin-image suites (`packages/*/test/images-1326.test.ts`) decode checked-in codec fixtures
(`packages/data/fixtures/images/`, generated once with libjpeg-turbo + ffmpeg), assert the three wire
formats byte for byte against recorded terminal replies, and drive the screens with an offline ImageService.
The filter grammar suite (`packages/cli/test/filter.test.ts`) checks `vol24 > 250K liq > 50K`
against a hand-written predicate on fixture and real rows, plus every error message.
`packages/cli/test/live.test.ts` and `packages/data/test/task-1298.test.ts` replay
`packages/data/fixtures/task-1298-sample.json` (Helius mint + holders with the key redacted, GoPlus,
GeckoTerminal trades, RugCheck `new_tokens`, a 60 s PumpPortal session) through the live bindings and screens.

```sh
node packages/cli/tools/shot.mjs --out DIR                 # 26 cyberspace PNGs: 5 screens × 176/120/90, calm set, boot, pump, glitch, dump, normal, midnight
node packages/cli/tools/shot.mjs --replay FILE --out DIR   # the live app over a recording (screener + the demo-data screens)
node packages/cli/tools/shot.mjs --legacy --out DIR        # the nine SPEC §7.8 v1-theme frames
node packages/cli/tools/contrast.mjs [--json out.json]     # readability report, exit 1 if a numeric cell is below 4.5:1
node packages/cli/tools/demo.mjs --out DIR                 # 21.5 s 1920×1080 30 fps mp4 + contact sheet (headless Chrome → ffmpeg)
python3 -I packages/cli/tools/cpu-measure.py --seconds 60 -- --intensity fever   # idle CPU in a pty
```
(`shot.mjs` and `demo.mjs` need puppeteer in a parent `node_modules` and `demo.mjs` needs ffmpeg; neither is a dependency.)

## Customization (task-1358)

Everything under `~/.dexterm/` (`DEXTERM_HOME`); `config.json` is machine-written (v4, 0600, journaled with inverses: `ctrl+z` undoes),
holds no secrets by construction (the schema has no key field; an old config with a key gets it moved out to `<name>.key`).

- **Workspaces** — `~/.dexterm/workspaces/<name>.json`: start screen, theme, intensity, screener preset/filter/sort, token panels, per-screen pane trees for the layout solver, and the HUD popups to open together. `ctrl+w` then `w` list · `n`/`N` next/prev · `s` save as · `m` morning HUD · `o` popups · `d` default · `1-9`; `--workspace <name>`; `dexterm workspace list|show|remove|init`. A switch is a UI action: it can navigate, re-theme and open read-only windows, never a ticket.
- **Themes + keymaps** — `~/.dexterm/themes/<name>.json` (`extends` a built-in + `tokens`; hex-only, a contrast floor and an up/down hue guard so a shared theme cannot hide a warning or swap buy/sell colours), `config.theme.overrides`; `config.keymap` re-binds actions (reserved keys `ctrl+c esc enter y !` and the confirm/dismiss/panic/quit actions are refused by name; collisions and chord-prefix clashes refuse the whole keymap). `dexterm theme list|show|init|check`, `dexterm keymap [screen]`.
- **Price display mode** (task-1366) — `$` flips USD price ⇄ MARKET CAP on the screener, watchlist, new pairs, token screen, both charts (Y axis in K/M/B; the popup legend shows the price in parentheses), order-plan levels and position rows; saved as `config.display.priceMode` (`dexterm display [price|mcap]`, `--price-mode`, a workspace's `priceMode`). Market cap = price × the supply the sources report (mcap ÷ price at the latest tick); history uses the CURRENT supply and every mcap chart says `mcap (current supply)`; a token without a supply shows its price marked `ᵖ` / `supply unknown · showing price`. Display only: `packages/cli/src/display.ts`; nothing that trades reads it.
- **Rules engine** — `when <cond> [for n ticks] then alert|ticket|ask|popup|tag|sound|watch [cooldown] [max n/h] [scope] [window] [name]`, parsed never eval'd, mandatory cooldown + max/h, a live dry-run while typing (`ctrl+r`, `dexterm rules …`). Rules only alert, annotate your own watchlist, open read-only popups, or PROPOSE: ticket/ask become proposal cards that open the PAPER ticket editor / ask the analyst on your keypress. Money-shaped args (`arm`, `auto`, `sign`, …) are refused at parse time, in text and in JSON.
- **Packs** — a directory of the above (+ popup widgets) with a sha256 `pack.lock` and an optional `ssh-keygen -Y` signature; trust reviewed > signed > unsigned. `dexterm pack verify|add|remove|export|lock|sign|trust|signers|keymap|widget|list`. A pack never runs code: widgets install DISABLED, unsigned rules load disabled, the keymap merges only with `pack keymap <name> --merge`, and every load re-hashes the installed copy. Malicious-pack suite in `packages/custom/test/packs.test.ts` + `packages/cli/test/pack-1358.test.ts`.
- **Knowledge base + skills** (task-1377) — your own copies live in `~/.dexterm/kb/entries/<id>.md` and `~/.dexterm/skills/<name>.md`, the same frontmatter + markdown as the bundled 17 KB entries and analyst skills. Same id as a bundled one = your file overrides it; a new id = added; the bundled files are never edited. `dexterm kb|skill list|show|new|edit|check|reset|path`: `edit` copies the bundled file into `~/.dexterm` and opens `$VISUAL`/`$EDITOR` (no editor or no TTY: it prints the path to edit), `check` validates frontmatter and size (a KB entry ≤ 16 KB with a body ≤ 4000 chars, a skill ≤ 32 KB / 8000), `reset` moves your file to `<dir>/.reset/` so the bundled one is back. The MCP server (`dexterm mcp`, also for your own agent), the analyst and Jarvis read the MERGED set and re-check the files on every call or turn, so an edit needs no restart; a file that fails `check` is skipped with the reason (MCP stderr, `list`, `dexterm doctor`) and the bundled one stays in effect. Safety: a skill is read-only guidance: its `tools:` may name only read tools, and a skill that names a trade / sign / arm / ticket / send tool anywhere (`open_ticket`, `execute_swap`, `mcp__…`, `/wallet …`) or sets `allowed-tools` / `model` / `hooks` is refused. Your text is untrusted like token text: it reaches a model only through the prompt firewall (`<untrusted source="kb:user:…">`, a user skill behind a dexterm preamble), `kb_lookup` reports `origin: bundled|user`, and an address in a user KB entry shows as `[addr]` (a KB entry never holds facts about a live token; `check` warns). Packs do not carry KB entries or skills. Every new/edit/reset is journaled in `~/.dexterm/kb-skills.journal.jsonl` (hashes, not content). For example: `dexterm kb edit lp-burn-vs-lock` or `dexterm skill edit rug-check`, save, and ask the analyst again.
- **Widget API (beta)** — a pack widget is an html page the popup host serves inside its own wrapper window as a sandboxed iframe: the wrapper (ours, nonce CSP) owns the socket and names exactly one `frame-src`; the pack page runs under a hash-only CSP (every inline `<script>`/`<style>` allow-listed by sha256, no nonce, nothing substituted into the pack html; `<script src>`, `<link>`, frames, `<meta http-equiv>` and `@import` refused at install, open and ticket issue) with no network of its own (`connect-src 'none'`), an opaque origin, Trusted Types where the engine has them, no way to navigate anywhere (the parent's `frame-src` governs the child's every navigation), and — r4/r5 — a **DOM seal**: the SDK runs first and locks the DOM insertion methods, every HTML-parsing entry point (including the static `Document.parseHTMLUnsafe`), `adoptNode`/`importNode`, the element-taking setters and WebRTC on the prototypes, with a MutationObserver belt, and cancels any click on a link that targets another window (r6: WebKit opens a connection to the link's host:port before the sandbox refuses the popup), so none of the three connections no CSP directive covers (runtime preconnect, WebRTC, a targeted click) can be made by any path — without relying on Trusted Types, which the system WKWebView of macOS 14/15 lacks; verified on that WebView in the real shell and in headless Chromium + WebKit with a raw TCP sink. Widgets open only in the native shell (macOS 14+), which also routes every WebView connection through a loopback sink proxy (a backstop for named hosts). It is fed public view models (`rows · token · narrative · positions · alerts · theme`) by `postMessage` through a frozen `dexterm` SDK; it can only receive. `packages/popup/WIDGETS.md`; example `packs/example-widgets/`.

Not built from the task-1288 design: the in-process plugin sandbox (columns/panels, `net.fetch`, `storage.kv`), the Jarvis config assistant's `config_propose` MCP tools, `pack add` from git/zip, and a shipped reviewed-pack list (it is empty until a first-party pack is reviewed).

## Rules

- No runtime dependencies. Dev: `typescript`, `@types/node`.
- Nothing here holds keys, signs, or sends transactions.
- Token-originated strings are untrusted and go through the prompt firewall before any model sees them (D-12).
