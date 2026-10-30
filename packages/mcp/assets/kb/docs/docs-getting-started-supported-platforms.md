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

dexterm supports **macOS and Linux**. Windows is not supported. This table says what each platform has actually been through, not what we expect to work. "Tested" means the typecheck, the full offline test suite and an install smoke (`npm pack`, `npm i -g` of that tarball into an empty prefix with a fresh home, then `dexterm --version` and `dexterm doctor`) have passed there.

| platform | status | what has run on it |
|---|---|---|
| Linux x64, Node 22 and 24 | tested | the full suite on every push in CI (Ubuntu), and the same steps in Docker (`node:22-bookworm`, `node:24-bookworm`), including the install smoke |
| macOS on Intel | tested | the full suite on every change, the install smoke, and a Homebrew install (slow: Homebrew builds Node from source on Intel) |
| macOS on Apple Silicon | tested in CI (0.1.4) | the full suite on an Apple Silicon runner (`macos-14`) passed on the 0.1.4 release candidate. The manual Homebrew job (tap, trust, install, `brew test`) has not run yet |
| WSL2 | not tested separately | it is Linux, so expect the Linux behaviour |
| Windows | not supported | a CI leg ran the suite on Windows for 0.1.4, but Windows is not a supported platform: private files rely on POSIX file modes, voice has no Windows engine, and browser links and `doctor`'s fixes assume macOS or Linux |
