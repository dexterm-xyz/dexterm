// dexterm — "Watch it cook" launch (task-2170). The one place the web UI starts a local process, so it is narrow:
//   * ONE fixed command: `dexterm autotrade watch <id> --open-overlay` (the read-only watch window). No argv, flag, path
//     or shell text comes from the browser; the only variable is the strategy id, and it must match the id pattern AND
//     be one of the strategies the store lists right now (so `; rm -rf ~`, `../x`, a newline or an unknown id is refused).
//   * no shell: every launcher is spawned with an argv array (shell: false). On macOS the fixed AppleScript receives the
//     argv as `on run argv` arguments and quotes each with `quoted form of` before Terminal runs it.
//   * per OS: macOS Terminal via osascript; Linux the first of x-terminal-emulator / gnome-terminal / kitty / konsole /
//     xterm; Windows Windows Terminal (wt.exe), else `cmd /c start`. None found = the caller shows the exact command
//     to copy instead.
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WATCH_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
/** The only arguments a watch window gets after the dexterm entry; `<id>` is filled in after validation. */
export const WATCH_ARGS = ['autotrade', 'watch', '<id>', '--open-overlay'] as const;

/** The dexterm entry this process runs from (the bin when started as `dexterm`), else the checkout's bin shim. */
export function dextermEntry(argv1: string = process.argv[1] ?? ''): string {
  return /^dexterm(\.m?js)?$/.test(basename(argv1)) ? argv1 : fileURLToPath(new URL('../../bin/dexterm.mjs', import.meta.url));
}

export interface WatchCommand { argv: string[]; display: string; id: string }

/** Shell-quoted for a POSIX shell (copy/paste), or double-quoted for Windows. */
export function displayCommand(argv: string[], platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return argv.map((a) => (/^[A-Za-z0-9_\-.:\\/=]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`)).join(' ');
  return argv.map((a) => (/^[A-Za-z0-9_\-.,:/=@+]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/**
 * Build the fixed watch command for a strategy id. `knownIds` is the store's list at request time. `home` is the
 * server's own DEXTERM_HOME (never from the request), passed through `env` so the new terminal reads the same home.
 */
export function watchCommand(id: unknown, o: { knownIds: readonly string[]; home?: string | null; node?: string; entry?: string; platform?: NodeJS.Platform }): { ok: true; cmd: WatchCommand } | { ok: false; why: string } {
  if (typeof id !== 'string' || !WATCH_ID_RE.test(id)) return { ok: false, why: 'not a strategy id' };
  if (!o.knownIds.includes(id)) return { ok: false, why: `no strategy ${id}` };
  const node = o.node ?? process.execPath;
  const entry = o.entry ?? dextermEntry();
  const args = WATCH_ARGS.map((a) => (a === '<id>' ? id : a));
  const base = [node, entry, ...args];
  const platform = o.platform ?? process.platform;
  const argv = o.home && platform !== 'win32' ? ['/usr/bin/env', `DEXTERM_HOME=${o.home}`, ...base] : base;
  return { ok: true, cmd: { argv, display: displayCommand(o.home && platform === 'win32' ? base : argv, platform), id } };
}

/** Is an executable on PATH (no shell). */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['', '.exe', '.com'] : [''];
  for (const d of dirs) for (const e of exts) {
    const p = join(d, bin + e);
    try { if (existsSync(p)) { accessSync(p, constants.X_OK); return true; } } catch { /* not executable */ }
  }
  return false;
}

/** The fixed AppleScript: joins its argv with `quoted form of` and runs it in a new Terminal window. */
export const MAC_TERMINAL_SCRIPT = [
  'on run argv',
  'set cmd to ""',
  'repeat with a in argv',
  'set cmd to cmd & quoted form of (a as text) & " "',
  'end repeat',
  'tell application "Terminal"',
  'activate',
  'do script cmd',
  'end tell',
  'end run',
] as const;

export interface LaunchPlan { via: string; bin: string; args: string[] }

/** How this OS opens a terminal running `argv`; null when no known terminal is available. */
export function terminalPlan(argv: string[], o: { platform?: NodeJS.Platform; which?: (bin: string) => boolean } = {}): LaunchPlan | null {
  const platform = o.platform ?? process.platform;
  const which = o.which ?? ((b: string) => onPath(b, process.env, platform));
  if (platform === 'darwin') {
    if (!which('osascript')) return null;
    return { via: 'macOS Terminal (osascript)', bin: 'osascript', args: [...MAC_TERMINAL_SCRIPT.flatMap((l) => ['-e', l]), '--', ...argv] };
  }
  if (platform === 'win32') {
    if (which('wt')) return { via: 'Windows Terminal', bin: 'wt', args: ['new-tab', '--title', 'dexterm watch', ...argv] };
    return { via: 'cmd start', bin: 'cmd', args: ['/c', 'start', 'dexterm watch', ...argv] };
  }
  const linux: Array<[string, (a: string[]) => string[]]> = [
    ['x-terminal-emulator', (a) => ['-e', ...a]],
    ['gnome-terminal', (a) => ['--', ...a]],
    ['kitty', (a) => a],
    ['konsole', (a) => ['-e', ...a]],
    ['xterm', (a) => ['-e', ...a]],
  ];
  for (const [bin, f] of linux) if (which(bin)) return { via: bin, bin, args: f(argv) };
  return null;
}

export type Spawner = (bin: string, args: string[], opts: SpawnOptions) => { pid?: number; unref(): void; on(ev: 'error', f: (e: Error) => void): unknown };

export interface LaunchResult { launched: boolean; via: string | null; command: string; why?: string }

/** Open a terminal window running the watch command. Never throws; a failure returns the command to copy. */
export function launchWatch(cmd: WatchCommand, o: { platform?: NodeJS.Platform; which?: (bin: string) => boolean; spawn?: Spawner; env?: NodeJS.ProcessEnv } = {}): LaunchResult {
  const plan = terminalPlan(cmd.argv, o);
  if (!plan) return { launched: false, via: null, command: cmd.display, why: 'no terminal found to open: run the command yourself' };
  try {
    const child = (o.spawn ?? (nodeSpawn as unknown as Spawner))(plan.bin, plan.args, { detached: true, stdio: 'ignore', shell: false, env: o.env ?? process.env, windowsHide: false });
    child.on('error', () => { /* reported as launched: the window may still have failed; the UI keeps the command */ });
    child.unref();
    return child.pid ? { launched: true, via: plan.via, command: cmd.display } : { launched: false, via: plan.via, command: cmd.display, why: `${plan.via} did not start` };
  } catch (e) {
    return { launched: false, via: plan.via, command: cmd.display, why: `${plan.via}: ${(e as Error).message}` };
  }
}

/** Open a loopback URL in the default browser (fixed argv; only http://127.0.0.1 URLs). */
export function openBrowser(url: string, o: { platform?: NodeJS.Platform; spawn?: Spawner } = {}): boolean {
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/[A-Za-z0-9/_\-.?=&%]*$/.test(url)) return false;
  const platform = o.platform ?? process.platform;
  const [bin, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    const c = (o.spawn ?? (nodeSpawn as unknown as Spawner))(bin, args, { detached: true, stdio: 'ignore', shell: false });
    c.on('error', () => {});
    c.unref();
    return true;
  } catch { return false; }
}
