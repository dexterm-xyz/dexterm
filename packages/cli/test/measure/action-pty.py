#!/usr/bin/env python3 -I
"""task-1313 UI-action pty harness.

Drives the REAL interactive dexterm in a pty over a recording (replay = live code
paths, no network), with a FAKE `claude` on PATH that, for one analyst turn,
writes an `open_token` line to the authenticated action channel and emits a
matching stream-json tool call. Proves that asking "put X on my screen" actually
puts the coin on screen: the app consumes the channel, applies the action, and
shows an "analyst opened …" note. Captures all pty output to --out.

Usage: python3 -I action-pty.py --sample FILE --fake-dir DIR --out FILE --home DIR
"""
from __future__ import annotations

import argparse
import fcntl
import os
import struct
import termios
import time
import select
import subprocess
import pty

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.abspath(os.path.join(HERE, "..", "..", "bin", "dexterm.mjs"))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
COLS, ROWS = 140, 40


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", required=True)
    ap.add_argument("--fake-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--home", required=True)
    ap.add_argument("--fake-log", default="")
    ap.add_argument("--scenario", default="open", choices=["open", "filter", "results"])
    args = ap.parse_args()

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    argv = ["node", BIN, "--replay", args.sample, "--no-boot", "--tz", "UTC"]
    env = dict(os.environ)
    env["PATH"] = args.fake_dir + os.pathsep + env.get("PATH", "")
    env["DEXTERM_OFFLINE"] = "1"
    env["DEXTERM_HOME"] = args.home
    env["COLUMNS"], env["LINES"] = str(COLS), str(ROWS)
    env["TERM"] = env.get("TERM", "xterm-256color")
    env["COLORTERM"] = "truecolor"
    if args.fake_log:
        env["DEXTERM_FAKE_LOG"] = args.fake_log
    env["DEXTERM_FAKE_SCENARIO"] = args.scenario

    proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=subprocess.DEVNULL,
                            env=env, cwd=ROOT, preexec_fn=os.setsid)
    os.close(slave)

    buf = bytearray()

    def drain(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.1)
            if r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                buf.extend(chunk)

    def send(data: bytes) -> None:
        os.write(master, data)

    prompts = {
        "open": b"put the top coin on my screen",
        "filter": b"show me coins under 5M mcap with over 100k liquidity, up on the day, not rugs",
        "results": b"what are the best setups right now",
    }
    drain(2.8)              # let the replay feed fill
    send(b"4")              # Analyst tab
    drain(0.6)
    send(b"i")              # focus the chat input
    drain(0.4)
    send(prompts[args.scenario])
    drain(0.3)
    send(b"\r")             # send the question → spawns the fake claude → writes the action
    drain(4.5)              # the app consumes the channel and applies the UI action
    if args.scenario == "results":
        send(b"\x1b")       # blur the input so the results table takes the arrows
        drain(0.3)
        send(b"\x1b[B")     # ↓ activate + move the results cursor
        drain(0.3)
        send(b"\r")         # ⏎ jump to the selected coin's token screen
        drain(1.2)
    send(b"q")              # quit
    # keep draining until exit
    t0 = time.time()
    while time.time() - t0 < 6:
        if proc.poll() is not None:
            break
        drain(0.2)
    if proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), 9)
        except ProcessLookupError:
            pass
    drain(0.3)

    with open(args.out, "wb") as f:
        f.write(bytes(buf))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
