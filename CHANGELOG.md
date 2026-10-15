# Changelog

All notable changes to dexterm are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) with the pre-1.0 caveat that minor versions may break things.

## [0.1.0] - unreleased

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
