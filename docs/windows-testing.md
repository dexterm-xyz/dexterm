# Native Windows CI scope

The Windows job runs typecheck, the offline parallel suite, serial tests, render
performance checks and a fresh-prefix package-install smoke test. A failure in
the supported suite fails the job; there is no experimental `continue-on-error`
allowance. Offline tests use fixture data and throwaway stores, not real wallets,
credentials or paid analyst calls. Hosted results, not a local macOS run, establish
whether this Windows gate passes.

## Exact platform limitations

- NTFS does not implement POSIX owner/group/other permission bits. Node's `chmod`
  is **not** proof of owner-only Windows ACLs. Only the exact mode assertions are
  named POSIX subtests, skipped on Windows with that reason. Their enclosing
  credential, config, fast-wallet, redaction, refusal and filesystem-content
  tests still run. The same assertions remain mandatory on Linux and macOS.
  Native Windows ACL isolation is **unverified**: review the account/directory's
  Security permissions before storing sensitive material. `doctor` and X status
  warn rather than claiming a successful `chmod` made the files private.
- Python's `pty`/`termios` harness is POSIX-only; tests explicitly check that
  capability. Those tests still run on Linux/macOS. This does not establish
  Windows ConPTY behavior. The in-process input/queue/interrupt/render tests and
  native CLI/install smoke still run on Windows.
- Microphone, native speech, browser-wallet approval and graphical popup hardware
  are not exercised by headless CI on any OS. Fake speech/analyst executables run
  as real Node child processes with pipes, arguments and cancellation checked;
  no shell execution or real model subscription is involved.

## Portability conventions

Use `fileURLToPath` for file URLs; `basename`/`relative` for filesystem paths;
normalize separators only when comparing a platform-independent manifest or import
closure. A synthetic POSIX PATH fixture must not contain a Windows drive colon.
Wait for child close and explicitly close SQLite stores before deleting fixtures.
The silent authenticated-host fixture tests request timeout on all platforms
without POSIX `SIGSTOP`/`SIGCONT`. None of these changes expands the signer or
analyst command surface.
