// dexterm T2 — the in-app `/wallet …` command grammar (task-1328). Pure: parse only. The LiveContext
// performs the command. `/wallet` alone = status. task-1571: dexterm holds no key and signs nothing; the
// linked wallet is a public key for display, and live trading happens in the Telegram trading bot of your choice.
export type WalletCommand = 'status' | 'link' | 'unlink' | 'panic';

/**
 * Parse a typed command: `/wallet` · `/wallet status` · `/wallet link` · `/wallet unlink` · `/wallet panic`.
 * The leading slash is optional (the screener's `/` line ate it). Anything else — including a real filter —
 * returns null. `resume` is deliberately NOT a command here: clearing the panic switch needs a real TTY
 * keypress in `dexterm wallet resume`.
 */
export function parseWalletCommand(text: string): WalletCommand | { error: string } | null {
  const m = /^\s*\/?wallet(?:\s+(\S+))?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const arg = (m[1] ?? '').toLowerCase();
  if (arg === '' || arg === 'status') return 'status';
  if (arg === 'link') return 'link';
  if (arg === 'unlink') return 'unlink';
  if (arg === 'panic') return 'panic';
  if (arg === 'resume') return { error: 'resume needs a real terminal keypress: run `dexterm wallet resume` in a shell' };
  return { error: `unknown /wallet command "${arg.slice(0, 16)}" (status · link · unlink · panic)` };
}

export const WALLET_HELP = `  /wallet [status]          linked wallet (public key only, read-only) and the panic state
  /wallet link              open the browser to link a Phantom wallet (sign-a-message proof; no transaction)
  /wallet unlink            forget the linked public key
  /wallet panic             halt autotrade runs and the paper agent desk at once (kill-switch file); resume needs \`dexterm wallet resume\`
  dexterm never holds a key and never signs. Live trading happens in the Telegram trading bot of your choice.`;
