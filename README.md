# dexterm

**A terminal for the trenches.** A Solana memecoin screener that runs in your terminal, with your own `claude` command line as the analyst. Keyless market data, no account, no server, no telemetry. Trading in dexterm is simulated (paper). dexterm never holds a key and never signs; live trading happens in the Telegram trading bot of your choice.

> **Status: early.** dexterm is pre-1.0. Screens, keys and output change between versions. **Trading is the roughest part.** Paper trading, paper autotrade and the Telegram connector are experimental and have bugs we are still fixing, so do not rely on them. The Telegram live path is a first cut (0.1.7): dexterm sends alerts and signals to your own bot and does not place orders in a trading bot yet. It shows you data and a model's reading of that data; it is not financial advice and it will be wrong sometimes. Read [what it can and cannot do](#the-safety-model) before you trust it with anything.

[![ci](https://github.com/dexterm-xyz/dexterm/actions/workflows/ci.yml/badge.svg)](https://github.com/dexterm-xyz/dexterm/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/dexterm-xyz/dexterm/badge)](https://scorecard.dev/viewer/?uri=github.com/dexterm-xyz/dexterm)

## What it does

- **Screener**: hundreds of Solana pairs from public, keyless APIs (DexScreener, Jupiter, GeckoTerminal), with a filter grammar (`vol24 > 250K liq > 50K`), sort menus, presets, and a spotlight on the hovered coin.
- **Token screen**: price, candles, trade tape or buy/sell flow, holders, mint/freeze authority, RugCheck and GoPlus safety reads, links, and a LARP check on the project's website and socials.
- **New pairs**: a live push feed of launches and migrations with launch forensics.
- **Watchlist and alerts**, persisted locally in SQLite.
- **The analyst**: press `a` and your own Claude Code login reads the same tool results (through dexterm's read-only MCP server) and answers in plain language (from 0.1.5 it can run on your own Codex login instead, locked read-only). Every answer is labelled model output with the age of every number. Token names, descriptions and fetched pages reach the model wrapped as untrusted text.
- **Paper trading and autotrade**: a simulated (paper) wallet priced from live quotes, for tickets, positions, order plans and copy trading; paper autotrade strategies with backtests on your recorded history, several strategies at once, shared paper accounts, and one trade ledger. Experimental, with known bugs.
- **Live trading, experimental (0.1.7)**: dexterm never holds a key and never signs; live trading happens in the Telegram trading bot of your choice; dexterm 0.1.7 sends alerts and signals to your own bot and does not place orders in it yet; automated order forwarding is next (0.1.8).
- **Your own Telegram bot**: alerts, `/status`, `/pause`, `/resume`, `/kill`, `/flatten` and one-tap approvals of paper entries during a paper autotrade run, through a bot you create; the token stays in your OS keychain.
- **A local model**: the analyst, your agents and paper autotrade sessions can run on Ollama on your own machine, inside a restriction profile you choose.
- **A docked chart window** (TradingView Lightweight Charts, vendored, served from a loopback-only server) when you opt into building the small native shell.
- **An MCP server** (`dexterm mcp`) so your own agents can use the same read-only tools. From 0.1.5, and only if you start `--agent-paper` on a mandate you armed, an agent you connected can also paper trade (simulated only) inside that mandate.

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

### With Homebrew (macOS)

```sh
brew tap dexterm-xyz/dexterm
brew trust dexterm-xyz/dexterm   # Homebrew 7+ loads third-party taps only after you trust them
brew install dexterm
dexterm doctor
```

Without the trust step, `brew install dexterm` stops with "Refusing to load formula … from untrusted tap". The one-line form `brew install dexterm-xyz/dexterm/dexterm` also works: naming the formula in full trusts that one formula. The formula installs the same release tarball with Homebrew's own Node. Homebrew no longer ships prebuilt packages for Intel Macs, so there it builds Node and its toolchain from source, which takes a long time; the release installer above is much faster on Intel.

### With npm

```sh
npm i -g dexterm-cli
dexterm doctor
```

The package is called `dexterm-cli` because npm refuses the name `dexterm` as too similar to `xterm`; the command it installs is still `dexterm`. The npm package ships compiled JavaScript, so it needs no build step. Every GitHub release also carries a Sigstore build-provenance attestation and `SHA256SUMS` you can verify (see [docs/verify-your-download.md](docs/verify-your-download.md)).

### Optional pieces

- **The analyst** needs [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on your PATH). Usage is billed to your own Anthropic account. Everything else works without it.
- **A Helius RPC key** (free tier) unlocks holder data and a faster on-chain lane. Write it to `~/.dexterm/helius.key`; `dexterm doctor` prints the command. Keyless, the public RPC is used and the missing fields say `needs key`.
- **The native chart window** builds in about a minute if you have a Rust toolchain (`cargo`); without it, charts open in your browser.

## Keys you will use first

`?` shows every key for the screen you are on. `q` quits. `⏎` opens the hovered coin, `a` asks the analyst, `/` filters, `w` watches, `c` opens the chart, `Esc` goes back.

## The safety model

**dexterm holds no key.** It has no trading wallet, no signer and no place to keep a private key, and it builds, signs and sends no transaction. Everything that trades in dexterm is paper (simulated). Live trading happens in a Telegram trading bot of your choice, which holds its own wallet; in 0.1.7 dexterm only sends alerts and signals to your own bot, and you act in the trading bot yourself.

What dexterm **never does**, on any published version:

- see, store, create or import a private key or seed phrase: `dexterm wallet link` only asks Phantom to sign a **message** that proves which wallet is yours, and dexterm stores the public key to show your address;
- build, sign or send a transaction, on any network: there is no code for it in the build, and a test fails if signing or key-storage code comes back;
- act without you: models, voice, agents and chat can only propose; arming a plan takes a physical keypress, and Telegram chat can make a paper run safer (pause, stop, flatten), never less safe;
- give the model a way to trade: the analyst and the MCP server have no build, sign or send tool; the most the analyst can do is navigate and open a PAPER ticket, and an agent you opt in with `--agent-paper` can only book simulated (paper) trades inside a mandate you armed (its tools never carry caps);
- open a server reachable from outside your machine (the chart server and the wallet-link page bind `127.0.0.1` with per-use tickets);
- phone home: no telemetry, no crash reports, no account. The once-a-day update notice is two anonymous GET requests with fixed headers; `dexterm update --off` turns it off.

**Live trading is yours and your trading bot's.** dexterm does not promise fills, prices or returns, and it cannot see or stop what your trading bot does. A real fill pays real slippage and fees, and most memecoins go to zero. Fund a trading bot only with what you can afford to lose.

What it **does** send over the network: requests from your machine to the public data APIs (the addresses you look at, your IP), WebSocket subscriptions to the new-pairs feed and the RPC, a read-only fetch of a token's website only when you press the link keys, the prompt dexterm builds to Anthropic through your own `claude` login if you use the analyst, and, if you set up Telegram, requests from your machine to the Telegram Bot API for your own bot. `dexterm doctor` lists every host; the [trust page](https://dexterm.xyz/trust/) explains each one.

Everything it stores is local and yours to delete: a SQLite database (cache, watchlist, request counters, the paper wallet) under your home directory, a small state file, the optional RPC key file, and, if you use them, the order-plan and copy journals, autotrade strategies and run files, the trade ledger, the Telegram pairing and audit files (the bot token stays in your OS keychain) and your linked wallet's public key.

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
