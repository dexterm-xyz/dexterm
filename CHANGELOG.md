# Changelog

All notable changes to dexterm are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) with the pre-1.0 caveat that minor versions may break things.

## [0.1.2] - 2026-10-16

A reliability and reach release: a sensible default voice, a fix for the "history failed" error on the token screen, a built-in update check, headless alerts, one-step agent setup, early Linux voice support, and a way to export and share what you see. Trading is still experimental.

### Added

- **`dexterm update`**: checks for a newer release and updates an npm or source install in place; `dexterm update --off` turns off the once-a-day startup notice (so does `DEXTERM_NO_UPDATE_CHECK=1`). The check is two anonymous GETs to `registry.npmjs.org` and `api.github.com` and sends no telemetry.
- **Push alerts and `dexterm watch`**: run your rules headless, with the terminal closed, and have alerts pushed to your desktop, your own Telegram bot or a Discord webhook. Delivery is opt-in and off by default; dexterm connects to Telegram or Discord only after you enable and configure it, and your tokens stay local and are never logged. `watch` has no signer and only ever raises proposals.
- **One-step agent setup**: `dexterm mcp install <client>` writes the MCP config for `claude-code`, `claude-desktop`, `cursor`, `codex`, `openclaw` or a generic agent — it shows the exact change, asks first, is idempotent and backs the file up — and `dexterm mcp doctor` connects to the server and lists its tools. The read-only MCP server now exposes 25 tools, including a one-call `larp_check`, and agents have per-agent capability tiers and standing mandates.
- **Export and share a view**: press `E` (or run with `--export`) to save the current screen as a PNG and a plain-text report under `~/.dexterm/exports` (local only). Paste a contract address or a token link anywhere a prompt accepts one to jump straight to that coin.
- **Linux voice (beta)**: optional Piper (text-to-speech) and whisper.cpp (speech-to-text) engines, with `dexterm voice` to download the models from Hugging Face when you ask for them. Real speaker and microphone I/O on Linux is not yet verified on hardware; treat it as beta.
- **LARP and skill backtests**: the LARP detector's links/domain/activity check now has a measured accuracy from a held-out backtest, reported honestly — on its own it is a weak signal, not a verdict — and saved skills can be backtested against held-out history the same way.

### Changed

- **A sensible default voice.** Voice output now defaults to an explicit deep British voice (Eddy, with Daniel as the fallback) instead of the machine's system voice, which varied by machine and could be a novelty voice. A novelty voice can never be auto-selected. Speech is sanitised before it is spoken and queued so lines do not overlap, and `voice.name`, `voice.rate` and `voice.pitch` are configurable.

### Fixed

- **"History failed" on the token screen.** Holder and transaction history now loads: a Helius request could reject a whole page of results when a single older transaction did not fit a version limit; that is fixed, and the pump.fun replay used in tests is now deterministic.

### Known issues

- **Trading is still experimental.** Paper trading and the live (wallet-signed) path still have bugs; do not rely on either for anything that matters.

## [0.1.1] - 2026-10-15

The first release published to npm. `npm i -g dexterm-cli` now installs it (npm refuses the name `dexterm` as too similar to `xterm`; the command is still `dexterm`). This upload was published by hand, so it has no build provenance yet. The GitHub release tarball and the Homebrew tap are unchanged.

### Added

- **`npm i -g dexterm-cli`**: dexterm is now on npm as `dexterm-cli`, published by hand without provenance. The package ships compiled JavaScript so a global install needs no build step (the release tarball and a checkout still run the TypeScript sources directly).
- **Go to a coin by address**: press `g` on the screener, new pairs, watchlist or a token to open a prompt, paste a contract address, and jump straight to that token.

### Fixed

- **Paper trade quotes no longer time out.** Paper fills fetch their Jupiter quote at high priority, so a ticket no longer fails with "quote timed out" when the shared quote budget is busy with screener enrichment.

### Known issues

- **Trading is still experimental.** Paper trading and the live (wallet-signed) path still have bugs; the quote fix above removes one failure mode but does not make either path reliable. Do not rely on them for anything that matters.

## [0.1.0] - 2026-10-15

First public release. Items marked *in progress* ship in this release but are labelled experimental or partial in the app; they are not a promise.

### Added

- **Screener and feeds**: a live Solana screener from keyless public APIs (DexScreener, Jupiter, GeckoTerminal) with a filter grammar (`vol24 > 250K liq > 50K`), sort menus, feed presets, an instant first paint, a trending board, coin pictures in the terminal, a sub-second on-chain price lane for pump.fun coins, and a market-cap display mode.
- **New pairs**: a live push feed of launches and migrations, with snipers and bundled supply from the wallet-intel scan.
- **Token screen**: market stats, mint and freeze authority, holders with a bubble map that classes every top holder, RugCheck and GoPlus reads, candles from 1m to 1d, a buy/sell flow panel, a social panel with spam and prompt-injection filtering, and the token's advertised links.
- **LARP detector**: a check of a token's website, domain registration and GitHub activity, with a verdict badge. Its accuracy is not measured yet (*in progress*).
- **The analyst**: your own `claude` login reads the same data through dexterm's read-only MCP server and answers in a few decided lines. It knows what is on screen, turns plain language into filters, and can navigate for you. Every answer is labelled model output. An AI scan mode watches the screener using only data already on hand; it is observe-only and capped. Analysis packs, a narrative board and one-line digests are *in progress*.
- **Watchlist, alerts and a rules engine**: a local watchlist, alerts that stay proposals until you press a key, and `when … then …` rules with mandatory cooldowns.
- **Paper trading** (*in progress*, known issues): a simulated wallet priced from live Jupiter quotes, a confirm gate that is on by default, positions and history, and trade-moment effects and sound that fire only after a result.
- **Live trading, non-custodial** (*in progress*): `L` on a ticket hands a capped transaction to your own Phantom wallet to sign, on a one-shot loopback page. Your wallet's keys never enter dexterm; only your public key is stored. A separate signer process builds and simulates every transaction. It enforces per-trade and daily USD caps and price-impact, slippage and SOL-out ceilings, and has a panic switch. Devnet is the default; mainnet needs `--mainnet` and shows a red banner. The live path is still maturing and does not promise fills or returns.
- **Order plans and standing mandates** (*in progress*): "buy if it dips to 300k, sell half at 600k" becomes an inert proposal that only a held keypress can arm. The executor re-checks the caps on every fill, and a hash-chained journal records everything. Paper by default; a devnet fire path uses an optional, capped, devnet-only fast wallet.
- **Copy trading** (*in progress*): follow a wallet, see its decoded swaps and realised PnL, and preview a mirror ticket. A capped auto-mirror turns on only with a keypress and the "less safe" confirmation. Paper by default; mirror-sell is not built.
- **Popup windows**: a TradingView Lightweight Charts popup (vendored, loopback-only) with your position on the chart. It docks beside the terminal on macOS and opens in your browser elsewhere. Token, feeds and bubble-map popups too.
- **Voice** (macOS): Jarvis push-to-talk for screens, coins, filters and PAPER tickets. It asks when unsure instead of guessing, and it can never arm, sign or raise a cap.
- **Bring your own agent**: a read-only MCP server (`dexterm mcp`), a loopback agent bus with per-agent capability tiers (observe, annotate, propose), and agent packs served over MCP. An agent roster can pause or kick any agent and shows the audit log. Agents are untrusted by default.
- **Customization**: workspaces and a morning HUD, user themes and keymap overrides with a contrast guard, shareable packs with a hash lock and an optional ssh signature (*in progress*), and a sandboxed popup widget API (*beta, in progress*).
- **Social**: KOL lists and Login with X (OAuth 2.0 PKCE on a loopback callback with your own X app, read scopes only).
- **Local history recorder**: keeps what the app saw, plus code-only outcome labels, in your local database for backtests. Nothing is uploaded.
- **Install and health**: a user-level installer (no `sudo`), `dexterm doctor` with the exact fix for anything missing, and a keyless path for every feature. A health registry shows `unavailable` or `needs key` instead of a made-up number.
- **Release pipeline**: a reproducible source tarball, SHA256SUMS, a build-provenance attestation, a CycloneDX SBOM, and VirusTotal and supply-chain scan results on the trust page.

### Known issues

- **Trading is experimental.** Paper trading and the live (wallet-signed) path both have bugs in this release: the ticket flow, simulated fills and the wallet hand-off can misbehave. We are fixing them in the open; do not rely on either for anything that matters.
