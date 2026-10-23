// dexterm — `dexterm wallet <link|unlink|status|panic|resume>` (SPEC §6.5). A non-TUI one-shot that
// links a Phantom wallet through the loopback bridge (sign-a-message only: dexterm keeps the PUBLIC key,
// never a private key, and signs nothing), unlinks it, prints the link, or engages the PANIC switch (a
// kill-switch file every dexterm process re-reads: autotrade runs and the paper agent desk halt).
// `resume` needs a real TTY keypress; piped input cannot re-arm. task-1571: dexterm holds no key and has
// no trading wallet; live trading happens in the Telegram trading bot of the user's choice.
import {
  WalletBridge, WalletLinkStore, shortPubkey, KillSwitch,
  type BridgeOpener, type LinkedWallet,
} from '@dexterm/data';

/** The slice of a TTY stdin the resume gate needs. A piped stdin has `isTTY` undefined/false. */
export interface KeyInput {
  isTTY?: boolean;
  setRawMode?: (raw: boolean) => unknown;
  once(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
  off?(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface WalletIo {
  stdout: { write(s: string): void; isTTY?: boolean };
  stderr: { write(s: string): void };
  env: NodeJS.ProcessEnv;
  stdin?: KeyInput;
}

export interface WalletCmdOverrides {
  /** Inject a bridge (tests); default is a real loopback bridge opening the system browser. */
  bridge?: WalletBridge;
  /** Inject a store (tests); default persists to ~/.dexterm/wallet-link.json. */
  store?: WalletLinkStore;
  /** Override the opener for the default bridge (tests / popup-host lane). */
  open?: BridgeOpener;
  /** Inject the panic switch (tests); default ~/.dexterm/trading.panic. */
  killSwitch?: KillSwitch;
  /** Keypress timeout for `resume` (ms). */
  keypressTimeoutMs?: number;
}

function panicLine(ks: KillSwitch): string | null {
  const p = ks.engaged();
  if (!p) return null;
  return `⛔ PANIC ENGAGED${p.engagedAt ? ` at ${new Date(p.engagedAt).toISOString()}` : ''} (${p.reason}): autotrade runs and the paper agent desk stay halted. Run \`dexterm wallet resume\` in a terminal to clear it.`;
}

function printStatus(io: WalletIo, store: WalletLinkStore, ks: KillSwitch): void {
  const w: LinkedWallet | null = store.get();
  if (w) io.stdout.write(`linked: ${shortPubkey(w.publicKey)}  (${w.publicKey}) · public key only, read-only\n`);
  else io.stdout.write('linked: (none) — run `dexterm wallet link`\n');
  const p = panicLine(ks);
  if (p) io.stdout.write(`${p}\n`);
  io.stdout.write('dexterm holds no key and signs nothing. Live trading happens in the Telegram trading bot of your choice (dexterm telegram setup).\n');
}

/**
 * Wait for ONE real keypress on a TTY. Resolves with the key, or null when stdin is not a TTY (piped
 * input, a subprocess, an agent) or no key arrives in time. Raw mode means a single keystroke — not a
 * buffered line — and `isTTY` is the kernel's word, not the caller's: `echo y | dexterm wallet resume`
 * is refused because a pipe is never a TTY.
 */
export async function ttyKeypress(stdin: KeyInput | undefined, timeoutMs: number): Promise<string | null> {
  if (!stdin || stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') return null;
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { stdin.off?.('data', onData); } catch { /* ignore */ }
      try { stdin.setRawMode?.(false); } catch { /* ignore */ }
      try { stdin.pause?.(); } catch { /* ignore */ }
      resolve(v);
    };
    const onData = (chunk: Buffer | string) => finish(chunk.toString('utf8').slice(0, 1));
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { stdin.setRawMode?.(true); } catch { finish(null); return; }
    stdin.once('data', onData);
    stdin.resume?.();
  });
}

/** Run the wallet subcommand. Returns a process exit code. */
export async function runWallet(argv: string[], io: WalletIo, over: WalletCmdOverrides = {}): Promise<number> {
  const sub = argv[0] ?? 'status';
  if (sub === 'trading' || sub === 'fast' || sub === 'probe') {
    io.stderr.write(`dexterm wallet ${sub}: removed in 0.1.7. dexterm holds no key and has no trading wallet; live trading happens in the Telegram trading bot of your choice\n`);
    return 2;
  }
  const store = over.store ?? new WalletLinkStore();
  const ks = over.killSwitch ?? new KillSwitch();

  if (sub === 'status') {
    printStatus(io, store, ks);
    return 0;
  }

  if (sub === 'unlink') {
    const had = store.clear();
    io.stdout.write(had ? 'unlinked.\n' : 'no wallet was linked.\n');
    return 0;
  }

  // PANIC: instant, no confirmation, scriptable from anywhere (a second terminal, a hotkey, an agent).
  // Engages the kill-switch file; every autotrade runner and the paper agent desk re-read it on each step.
  if (sub === 'panic') {
    const reasonIdx = argv.indexOf('--reason');
    const reason = reasonIdx >= 0 && argv[reasonIdx + 1] ? argv[reasonIdx + 1] : 'manual panic';
    const rec = ks.engage(reason);
    io.stdout.write(`⛔ PANIC: autotrade and the paper agent desk halted (${rec.reason})\n`);
    io.stdout.write(`kill switch: ${ks.path}\nClear it only from a real terminal: dexterm wallet resume\n`);
    return 0;
  }

  // RESUME: the only way back. Requires a physical keypress on a TTY — not piped/scripted input — so a
  // model or a script cannot silently clear the panic switch.
  if (sub === 'resume') {
    const stdin = io.stdin;
    if (!stdin || stdin.isTTY !== true) {
      io.stderr.write('dexterm wallet resume: needs a real terminal keypress (stdin is not a TTY). Refusing.\n');
      return 2;
    }
    if (!ks.engaged()) { io.stdout.write('the panic switch is not engaged; nothing to resume.\n'); return 0; }
    io.stdout.write(`${panicLine(ks) ?? ''}\nPress Y to clear the panic switch (any other key aborts)… `);
    const key = await ttyKeypress(stdin, over.keypressTimeoutMs ?? 30_000);
    io.stdout.write('\n');
    if (key === null) { io.stderr.write('dexterm wallet resume: no keypress; still panicked.\n'); return 2; }
    if (key !== 'y' && key !== 'Y') { io.stdout.write('aborted; still panicked.\n'); return 1; }
    ks.release();
    io.stdout.write('✓ panic switch cleared.\n');
    return 0;
  }

  if (sub === 'link') {
    const bridge = over.bridge ?? new WalletBridge(over.open ? { open: over.open } : {});
    io.stdout.write('Opening your browser to link a Solana wallet (sign-a-message only; no transaction)…\n');
    try {
      const res = await bridge.link();
      const rec = store.set(res.publicKey);
      io.stdout.write(`linked: ${shortPubkey(rec.publicKey)}  (${rec.publicKey}) · public key only; dexterm never signs with it\n`);
      return 0;
    } catch (e) {
      io.stderr.write(`dexterm wallet link failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  io.stderr.write(`dexterm wallet: unknown subcommand ${JSON.stringify(sub)} (expected link | unlink | status | panic | resume)\n`);
  return 2;
}
