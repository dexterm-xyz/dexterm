---
id: docs-getting-started-supported-platforms
title: Getting started › Supported platforms
kind: docs
page: getting-started
page_title: Getting started
heading: Supported platforms
anchor: supported-platforms
url: https://dexterm.xyz/docs/getting-started#supported-platforms
tags:
  - docs
  - getting-started
  - supported
  - platforms
  - getting
  - started
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/getting-started.md
date: 2026-10-16
---

This table says what each platform has actually been through, not what we expect to work. "Tested" means the typecheck, the full offline test suite and an install smoke (`npm pack`, `npm i -g` of that tarball into an empty prefix with a fresh home, then `dexterm --version` and `dexterm doctor`) have passed there.

| platform | status | what has run on it |
|---|---|---|
| Linux x64, Node 22 and 24 | tested | the full suite on every push in CI (Ubuntu), and the same steps in Docker (`node:22-bookworm`, `node:24-bookworm`), including the install smoke |
| macOS on Intel | tested | the full suite on every change, the install smoke, and a Homebrew install (slow: Homebrew builds Node from source on Intel) |
| macOS on Apple Silicon | not yet tested | a CI leg on an Apple Silicon runner (`macos-14`) and a manual Homebrew job (tap, trust, install, `brew test`) are written and lint clean; they run for the first time with the next release |
| Windows x64 | experimental, not yet tested | a CI leg (`windows-latest`) is written: typecheck and the install smoke must pass, the test suite may fail without failing the run. It has not run yet. Known gaps are listed below |
| WSL2 | not tested separately | it is Linux, so expect the Linux behaviour |

Known gaps on Windows (none of them affect key safety: dexterm never holds a wallet key on any platform):

- Files dexterm keeps private (tokens, the optional RPC key) are written with POSIX mode `0600`. Windows ignores that mode, so on Windows they are protected only by your user profile's normal permissions.
- The analyst runs `claude` without a shell, so it can start Claude Code's native installer build (`claude.exe`) but not the `claude.cmd` script an npm install creates. Doctor counts only `claude.exe` as found, so with an npm install it reports the Claude CLI as missing.
- Voice mode has no Windows speech engine (see voice (https://dexterm.xyz/docs/voice#linux-and-windows)).
- Opening a token's links and the PnL card's "share to X" do not start a browser on Windows; dexterm shows the URL to open yourself.
- `doctor` prints its fixes as POSIX shell commands (`mkdir -p`, `chmod`); in PowerShell, do the equivalent by hand.
- `dexterm kb edit` and `dexterm skill edit` do not open `$EDITOR`; they print the file to edit instead.
