# dexterm

**A terminal for the trenches.** A Solana memecoin screener that runs in your terminal, with your own `claude` command line as the analyst. Keyless market data, no account, no server, no telemetry. Trading is non-custodial and simulated (paper) by default: a real trade is signed by your own wallet, and your wallet's keys never enter dexterm.

> **Status: early.** dexterm is pre-1.0. Screens, keys and output change between versions. **Known issues in 0.1.0: paper and live trading are the roughest parts.** The ticket flow, simulated fills and the wallet hand-off have bugs we are still fixing, so treat all trading as experimental and do not rely on it. It shows you data and a model's reading of that data; it is not financial advice and it will be wrong sometimes. The live trading path is still maturing: it does not promise fills, prices or returns. Read [what it can and cannot do](#the-safety-model) before you trust it with anything.

<!-- badges land here once the repo is public and the pipeline has run:
[![ci](https://github.com/dexterm-xyz/dexterm/actions/workflows/ci.yml/badge.svg)](https://github.com/dexterm-xyz/dexterm/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/dexterm-xyz/dexterm/badge)](https://scorecard.dev/viewer/?uri=github.com/dexterm-xyz/dexterm)
-->

## What it does

- **Screener**: hundreds of Solana pairs from public, keyless APIs (DexScreener, Jupiter, GeckoTerminal), with a filter grammar (`vol24 > 250K liq > 50K`), sort menus, presets, and a spotlight on the hovered coin.
- **Token screen**: price, candles, trade tape or buy/sell flow, holders, mint/freeze authority, RugCheck and GoPlus safety reads, links, and a LARP check on the project's website and socials.
- **New pairs**: a live push feed of launches and migrations with launch forensics.
- **Watchlist and alerts**, persisted locally in SQLite.
- **The analyst**: press `a` and your own Claude Code login reads the same tool results (through dexterm's read-only MCP server) and answers in plain language. Every answer is labelled model output with the age of every number. Token names, descriptions and fetched pages reach the model wrapped as untrusted text.
- **Trading, paper by default**: a simulated (paper) wallet priced from live quotes, for tickets, positions, order plans and copy trading. Both paper and live trading are experimental in 0.1.0 and have known bugs. A **live** path, still maturing, sends a capped transaction to your own Phantom wallet to sign: devnet by default, mainnet only when you start dexterm with `--mainnet`. Every run starts on paper.
- **A docked chart window** (TradingView Lightweight Charts, vendored, served from a loopback-only server) when you opt into building the small native shell.
- **An MCP server** (`dexterm mcp`) so your own agents can use the same read-only tools.

## Install

You need **Node.js 22.18 or newer** (dexterm runs its TypeScript sources through Node's built-in type stripping; nothing is compiled). macOS and Linux; a truecolor terminal (iTerm2, Ghostty, WezTerm, Kitty, Alacritty, Windows Terminal) looks best but 256-colour and monochrome work.

### From a release (recommended)

1. Download `dexterm-<version>-src.tar.gz` and `SHA256SUMS` from the [releases page](../../releases).
2. **Verify it** (one minute, worth it): [docs/verify-your-download.md](docs/verify-your-download.md).
3. Unpack and run the installer. It is user-level: no `sudo`, no edits to your shell profile.

```sh
tar -xzf dexterm-<version>-src.tar.gz
cd dexterm-<version>
./install.sh          # finds or downloads a verified Node 22.18+, links the packages, writes ~/.local/bin/dexterm
dexterm doctor        # checks Node, the terminal, the optional claude CLI, every data source; prints the exact fix for anything missing
dexterm               # start
```

### From a checkout

```sh
git clone https://github.com/dexterm-xyz/dexterm.git && cd dexterm
npm run dexterm       # runs from the source tree; `npm install` is optional and only pulls the TypeScript dev tooling
```

Homebrew and npm installs are planned once the first release is out; see [docs/release-process.md](docs/release-process.md).

### Optional pieces

- **The analyst** needs [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on your PATH). Usage is billed to your own Anthropic account. Everything else works without it.
- **A Helius RPC key** (free tier) unlocks holder data and a faster on-chain lane. Write it to `~/.dexterm/helius.key`; `dexterm doctor` prints the command. Keyless, the public RPC is used and the missing fields say `needs key`.
- **The native chart window** builds in about a minute if you have a Rust toolchain (`cargo`); without it, charts open in your browser.

## Keys you will use first

`?` shows every key for the screen you are on. `q` quits. `⏎` opens the hovered coin, `a` asks the analyst, `/` filters, `w` watches, `c` opens the chart, `Esc` goes back.

## The safety model

Trading in dexterm is **non-custodial** and **paper by default**. Every run starts on the simulated wallet; nothing real is signed or sent until you switch a ticket to LIVE with a keypress and approve the transaction in your own wallet.

What dexterm **never does**, on any published version:

- see, store or import your wallet's private key or seed phrase: a real trade is signed in your own wallet (Phantom, on a one-shot loopback page in your browser), and dexterm stores only your public key;
- sign or send without you: models, voice, agents and pipes can only propose; arming a plan or sending a trade takes a physical keypress, and a Phantom trade also takes your approval in the wallet;
- trade outside the caps: a separate signer process enforces per-trade and daily USD caps, price-impact, slippage and SOL-out ceilings on every transaction, and refuses anything out of policy even if the UI, the model or a popup is compromised; devnet by default, mainnet only with `--mainnet` and a red banner;
- give the model a way to trade: the analyst and the MCP server have no build, sign or send tool; the most the analyst can do is navigate and open a PAPER ticket;
- open a server reachable from outside your machine (the chart server and the wallet bridge bind `127.0.0.1` with per-use tickets);
- phone home: no telemetry, no crash reports, no account, no update check.

The one key dexterm itself can hold is an optional **devnet-only fast wallet** that lets standing order plans fire on devnet without a wallet prompt per fill. It exists only if you run `dexterm wallet fast create` (a keypress on a TTY), lives at `~/.dexterm/fast-wallet.json` (mode 600), is never used on mainnet, and has no export or import.

**The live trading path is still maturing.** dexterm does not promise fills, prices or returns: a real fill pays real slippage and fees, a transaction can fail, and most memecoins go to zero. Use a wallet that holds only what you can afford to lose.

What it **does** send over the network: requests from your machine to the public data APIs (the addresses you look at, your IP), WebSocket subscriptions to the new-pairs feed and the RPC, a read-only fetch of a token's website only when you press the link keys, the prompt dexterm builds to Anthropic through your own `claude` login if you use the analyst, and, when you trade LIVE, the signer's quote, price and RPC requests and the transaction your wallet signed. `dexterm doctor` lists every host; the [trust page](https://dexterm.xyz/trust/) explains each one.

Everything it stores is local and yours to delete: a SQLite database (cache, watchlist, request counters, the paper wallet) under your home directory, a small state file, the optional RPC key file, and, if you use them, the order-plan and copy journals, the signer's cap and trade ledgers, your linked wallet's public key and the devnet fast-wallet key.

**Not financial advice.** Memecoins are adversarial. Data sources lag, lie or go down; the app says `unavailable` or `needs key` rather than inventing a number, and the analyst can be wrong or manipulated by text planted in a token's metadata. Verify before you act.

## Releases you can check

Every release is built by a public GitHub Actions workflow from a tagged commit and ships with `SHA256SUMS`, a Sigstore-signed build-provenance attestation, a CycloneDX SBOM, and `scan-results.json` with third-party scan results (VirusTotal, OpenSSF Scorecard, osv-scanner, gitleaks) that the trust page renders, including any false positive and what we did about it. How to check all of it: [docs/verify-your-download.md](docs/verify-your-download.md).

## Contributing, security, conduct

- Bugs and ideas: [issues](../../issues). Please include `dexterm doctor` output; it contains no secrets.
- Security problems: **do not open an issue.** See [SECURITY.md](SECURITY.md).
- Pull requests: [CONTRIBUTING.md](CONTRIBUTING.md). Be decent: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Maintainer notes for running and testing from a checkout: [docs/development.md](docs/development.md).

## Data attribution

Market data comes from DexScreener, Jupiter and GeckoTerminal (CoinGecko) under their free tiers and terms; launches from PumpPortal; safety reads from RugCheck and GoPlus; chain data from Solana RPC (Helius when you configure a key). Charts by [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) (Apache-2.0, vendored under `packages/popup/vendor/`). dexterm is not affiliated with any of them.

## License

See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright (C) 2026 The dexterm authors. Licensed under AGPL-3.0-only.
