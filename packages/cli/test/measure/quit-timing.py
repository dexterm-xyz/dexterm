#!/usr/bin/env python3 -I
"""task-1303 defect #1 quit-timing harness.

Starts the REAL interactive dexterm in a pty, lets the live wide-pool fill run
long enough that the paced background fill is parked in a DsPacer sleep, then
sends Ctrl-C (0x03) on the pty and measures wall-clock time to process exit.

Baseline (0d803c9) was ~0.03-0.04 s; the regression (aa83124) hung 35-43 s
because the paced sleep was a plain, non-unref'd setTimeout that close() never
cancelled. The fix makes the sleep unref'd + cancellable and close() abort it.

Usage: python3 -I quit-timing.py [--wait 25] [--calm] [--intensity fever]
"""
from __future__ import annotations

import argparse
import fcntl
import os
import pty
import struct
import termios
import time
import select

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", "bin", "dexterm.mjs"))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
COLS, ROWS = 176, 48


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait", type=float, default=25.0, help="seconds to let the fill run before quitting")
    ap.add_argument("--calm", action="store_true")
    ap.add_argument("--intensity", default=None, choices=["off", "normal", "fever"])
    ap.add_argument("--key", default="ctrlc", choices=["ctrlc", "q"], help="the quit keystroke to send")
    ap.add_argument("--open", action="store_true", help="press Enter early to open a token (engages the token loader + fast lane)")
    args = ap.parse_args()

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    argv = ["node", APP, "--no-boot"]
    if args.calm:
        argv.append("--calm")
    if args.intensity:
        argv += ["--intensity", args.intensity]

    env = dict(os.environ)
    env.pop("DEXTERM_OFFLINE", None)  # live feeds: we need the paced fill to run
    env["COLUMNS"], env["LINES"] = str(COLS), str(ROWS)
    env["TERM"] = env.get("TERM", "xterm-256color")
    env["COLORTERM"] = "truecolor"

    import subprocess
    proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=subprocess.DEVNULL,
                            env=env, cwd=ROOT, preexec_fn=os.setsid)
    os.close(slave)

    # Drain the pty so the app's writes never block while we wait for the fill.
    t0 = time.time()
    opened = not args.open
    while time.time() - t0 < args.wait:
        # Open a token a few seconds in: ⏎ opens the highlighted row so the token loader + fast lane run.
        if not opened and time.time() - t0 > 3.0:
            os.write(master, b"\r")
            opened = True
        r, _, _ = select.select([master], [], [], 0.25)
        if r:
            try:
                if not os.read(master, 65536):
                    break
            except OSError:
                break

    # Send the quit keystroke: Ctrl-C (0x03) or `q`; both reach the app's clean quit() in raw mode.
    os.write(master, b"q" if args.key == "q" else b"\x03")
    sent = time.time()
    # Keep draining until the process exits.
    while True:
        if proc.poll() is not None:
            break
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                os.read(master, 65536)
            except OSError:
                pass
        if time.time() - sent > 60:
            break
    exit_after = time.time() - sent
    code = proc.poll()
    if code is None:
        try:
            os.killpg(os.getpgid(proc.pid), 9)
        except Exception:
            pass
    os.close(master)

    label = "calm" if args.calm else (args.intensity or "fever")
    keyname = "q" if args.key == "q" else "Ctrl-C"
    openlbl = ", token open" if args.open else ""
    print(f"### quit timing: {label} (fill {args.wait:.0f}s{openlbl}, then {keyname})")
    print(f"- exit after {keyname}: {exit_after:.2f} s (exit code {code})")
    print(f"- verdict: {'PASS <1s' if exit_after < 1.0 else 'FAIL >=1s'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
