# Security policy

dexterm is a local terminal app that reads public market data and never holds a key and never signs: trading in dexterm is simulated (paper), and live trading happens in a Telegram trading bot of your choice, outside dexterm. It can talk to your own Telegram bot (alerts, run control, paper approvals). It also opens WebSockets, runs loopback HTTP servers for the chart window and the wallet-link page, fetches token websites on request, and feeds untrusted text to a language model. Bugs in any of that matter to us.

## Report a vulnerability

**Please do not open a public issue for a security problem.**

- Preferred: GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). It creates a private advisory only maintainers can see.
- Or email: `security@dexterm.xyz` (reaches the maintainers; use it if you cannot use the GitHub form).

Include what you can: the version or commit, your OS and terminal, steps to reproduce, and what you believe the impact is. `dexterm doctor` output helps and contains no secrets. If you have a proof of concept, attach it to the private report rather than describing it publicly.

## What to expect

| step | target |
|---|---|
| acknowledgement | within 3 days |
| first assessment (is it in scope, how bad) | within 7 days |
| fix or mitigation for a confirmed issue | within 30 days for high impact, 90 days otherwise; we will tell you if we need longer and why |
| credit | in the release notes and advisory, if you want it |

We do not currently pay bounties. We will never contact you first by DM about a report; anyone doing so in our name is not us.

## Scope

In scope:

- anything that lets a remote party read or change local state, or run code;
- anything that makes dexterm build, sign or send a transaction, or hold, read or ask for a private key or seed phrase (it should have no code that can);
- the wallet link: the one-shot loopback page, its token, Host/Origin checks and CSP, and the signed-message check;
- the Telegram connector: the bot token (keychain only, redacted everywhere), pairing, the allow-listed chat, the command list, and anything that lets chat make a run less safe or reach anything but the paper book;
- any path from a model, voice command, agent, chat message or token metadata to arming a plan or raising a limit;
- the loopback chart server and the native shell: ticket, token, Host/Origin checks, CSP, navigation pinning;
- the prompt firewall: untrusted text (token metadata, fetched pages, feeds) escaping its wrapping or steering the analyst into actions;
- the SSRF-safe page fetcher (private ranges, redirects, content types, size caps);
- the release pipeline: provenance, checksums, SBOM, the scan results on the trust page;
- the install script and the Node download verification.

Out of scope (still welcome as normal issues):

- the correctness of third-party market data, rug scores or the model's judgement;
- rate limiting by upstream APIs;
- issues that need a compromised local machine or a modified copy of dexterm.

## Supported versions

Only the latest release gets fixes. Pre-1.0, there is no long-term branch.

## How we handle a flagged scan

Every release artifact is scanned by VirusTotal and the results, including any engine that flags a file, are published on the trust page with a note. A flag is investigated like a report: reproduce with the exact hash, compare against the attested build, and either fix the cause or document the false positive next to the result. We do not hide or re-roll a flagged result.
