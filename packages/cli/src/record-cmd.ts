// dexterm — `dexterm record` (task-1414): a HEADLESS collector that keeps the history recorder fed when
// nobody has the TUI open. The recorder (task-1329) only grows while the interactive app runs; the backtest
// (task-1401) is only worth re-running on fresh data, so this command runs the exact same recorder jobs
// (observe snapshots + feed membership, the 1 h/2 h/6 h/24 h/72 h outcome sweeps, labels, retention) with no
// TUI, to be driven by a user-level launchd LaunchAgent on the Mac mini.
//
//   dexterm record [run] [--interval S] [--ticks N | --once] [--maintain S] [--max-db-mb N] [--retention-mb N] [--retention-days D]
//                        [--focus-ticks] [--no-newpairs] [--db PATH] [--verbose]
//   dexterm record install   [--interval S] [--max-db-mb N] [--retention-mb N] [--retention-days D] [--focus-ticks] [--load] [--dry-run]
//   dexterm record uninstall [--unload]
//   dexterm record status    [--db PATH]
//
// SAFETY / BUDGETS: this builds the keyless live feed and the recorder exactly as the live app does, so every
// request goes through the data layer's rate limiter + health gate and the sweep's own per-sweep / per-day caps
// (DEFAULT_SWEEP). It never builds a signer, never trades, never prints the Helius key (the URL is built inside
// the data layer; only the provider name is ever logged). Modest CPU: one feed refresh per `--interval` (60 s
// default) and recorder maintenance at most every `--maintain` seconds. A soft disk cap pauses OBSERVATION
// (the growth source) above `--max-db-mb` while labels + retention keep running, so the DB cannot run away.
// task-1504 (AUTOTRADE-SPEC §3, §10 Q4), both opt-in so an installed collector behaves as before until it is
// re-installed with them: `--retention-mb N` replaces that pause with eviction of the oldest history (observation
// never pauses), `--retention-days D` is the age rule for snapshot rows, and `--focus-ticks` runs the autotrade
// tick lane (5–10 s DexScreener samples of watchlist / held / candidate / open coins, plus 1m candles).
// task-1786 (winner-recall DATA-GAPS items 1-2), opt-in the same way: `--focus-module PATH` loads an ESM module whose
// `focus(now)` adds focus coins to the tick lane (the challenge / control coins live outside the app; the module that
// reads them lives with them), and `--exit-probes` adds a keyless Jupiter sell quote for every held focus coin once a
// minute (exit-probes.ts). Both imply --focus-ticks.
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultDbPath, resolveRpcUrl, extraRpcUrls, redactSecrets, type DataLayer } from '@dexterm/data';
import { PumpPortalClient } from '@dexterm/data';
import { Recorder, recorderEnabled, dbFocus, focusFilePath, readFocusFile, exitProbeDeps, DEFAULT_TICKS, type FocusEntry, type TickPollResult } from '@dexterm/recorder';
import { dextermHome } from './boot-state.ts';
import { createLiveFeed } from './feed.ts';
import { NewPairsLive } from './live/index.ts';

export interface RecordIo { stdout: { write(s: string): void }; stderr: { write(s: string): void }; env: NodeJS.ProcessEnv }

/** The LaunchAgent label (reverse-DNS). One collector per user. */
export const COLLECTOR_LABEL = 'xyz.dexterm.collector';
/** Default spacing between feed refreshes (one observation pass). Background work: keep it unhurried. */
export const DEFAULT_INTERVAL_MS = 60_000;
/** Default spacing between recorder maintenance passes (sweeps/labels/retention). */
export const DEFAULT_MAINTAIN_MS = 60_000;
/** Default soft cap on the whole DB file. Above it, observation pauses; sweeps/labels/retention continue. */
export const DEFAULT_MAX_DB_MB = 1024;

// ---------------------------------------------------------------- the collector engine (production + test seam)

/** What the collector loop drives. The production engine wraps the live feed + recorder; tests inject a fake. */
export interface CollectorEngine {
  /** One observation pass (a feed refresh): the recorder writes snapshots via the store listener. Returns rows written. */
  observe(): Promise<number>;
  /** Recorder maintenance: the outcome sweep (budgeted, low priority), labelling, and retention. */
  maintain(): Promise<void>;
  /** Force a retention pass now (disk-cap recovery). */
  prune(): void;
  /** task-1504: evict the oldest history down under the retention cap (when one is set). */
  enforceCap?(): { evicted: boolean; usedAfter: number; over: boolean } | null;
  /** task-1504: one autotrade tick-lane poll (when the lane is on). */
  pollTicks?(): Promise<TickPollResult>;
  /** Whole DB file size in bytes (cheap PRAGMA), or null when unavailable. */
  dbBytes(): number | null;
  /** New-pair mints currently tracked from the PumpPortal stream (diagnostics). */
  newPairs(): number;
  /** Close: labels whatever outcomes are due, then releases the DB + stream. */
  close(): void;
}

/** Build the real collector engine: the keyless live feed, the recorder attached to its store, and (unless
 *  disabled) the PumpPortal new-pairs stream folded into the feed's candidate pool so fresh launches get
 *  recorded before the REST feeds index them. */
export function buildLiveEngine(env: NodeJS.ProcessEnv, opts: { dbPath: string; noNewpairs?: boolean; verbose?: boolean; onLog?: (s: string) => void; retentionBytes?: number | null; retentionDays?: number | null; focusTicks?: boolean; extraFocus?: () => Iterable<FocusEntry>; exitProbes?: boolean }): CollectorEngine {
  const rpc = resolveRpcUrl({ env });
  const feed = createLiveFeed({
    dbPath: opts.dbPath, rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl, rpcPublicPool: true, rpcExtraUrls: extraRpcUrls(env),
    onRequest: opts.verbose ? (req, meta, o) => opts.onLog?.(`  ${meta.source.padEnd(14)} ${String(o.status ?? 'ERR').padStart(3)} ${String(o.latencyMs).padStart(5)}ms ${redactSecrets(req.url).slice(0, 110)}\n`) : undefined,
  });
  // Focus coins for the tick lane: the watchlist + paper positions in this DB, and whatever the autotrade runner /
  // the app publish in the focus file. Read on every poll (two indexed reads + one small file).
  const focusFile = focusFilePath(dextermHome(env));
  // task-1786: the focus module's coins. A throwing module costs its own coins only (logged at most every 10 min).
  let extraFailedAt = -Infinity;
  const extra = (): FocusEntry[] => {
    if (!opts.extraFocus) return [];
    try { return [...opts.extraFocus()]; } catch (e) {
      if (Date.now() - extraFailedAt > 600_000) { extraFailedAt = Date.now(); opts.onLog?.(`record: focus module failed: ${redactSecrets((e as Error).message)}\n`); }
      return [];
    }
  };
  const recorder: Recorder = new Recorder({
    path: opts.dbPath, onLog: opts.verbose ? opts.onLog : undefined,
    // The cap reclaims the data layer's expired cache entries (its own rule: a day past their TTL) before it evicts
    // any history; `feed` is built above, so the hook can reach it.
    ...(opts.retentionBytes ? { cap: { maxBytes: opts.retentionBytes, reclaim: () => feed.dl.cache.prune() } } : {}),
    ...(opts.retentionDays ? { retention: { columnsDays: opts.retentionDays } } : {}),
    ...(opts.focusTicks ? { ticks: { focus: () => [...dbFocus(recorder.database), ...readFocusFile(focusFile, Date.now()), ...extra()] } } : {}),
    ...(opts.focusTicks && opts.exitProbes ? { exitProbes: {} } : {}),
  });
  recorder.attach(feed.dl.store);
  let newpairs: NewPairsLive | null = null;
  if (!opts.noNewpairs) {
    newpairs = new NewPairsLive(feed.dl, {});
    // 0.1.5 dev history: keep the creator of every new pair in the recorder's creator index.
    newpairs.onCreator = (mint, creator, source, createdAt) => { recorder.recordCreator(mint, creator, source, undefined, createdAt); };
    const client = new PumpPortalClient({ health: feed.dl.health, clock: feed.dl.clock, onEvent: (ev) => newpairs!.handleEvent(ev), onStatus: () => {} });
    newpairs.attach(client, 'live');
    newpairs.start();
    const np = newpairs;
    feed.extraMints = () => [...np.rows.keys()];
  }
  const dl: DataLayer = feed.dl;
  const probeDeps = exitProbeDeps(dl);
  return {
    async observe(): Promise<number> {
      const before = recorder.counters.written;
      await feed.refresh();
      return recorder.counters.written - before;
    },
    async maintain(): Promise<void> { await recorder.maintain(dl); },
    prune(): void { try { recorder.prune(); } catch { /* logged inside; never fatal */ } },
    enforceCap() { return recorder.enforceCap(); },
    ...(opts.focusTicks ? { pollTicks: async () => {
      const r = await recorder.pollTicks(dl);
      // Detached: a quote waiting on the Jupiter bucket must never delay the next 5 s tick (the lane's own in-flight
      // guard keeps one probe pass at a time; it never throws).
      if (opts.exitProbes) void recorder.probeExits(probeDeps).catch(() => {});
      return r;
    } } : {}),
    dbBytes(): number | null {
      try {
        const db = recorder.database;
        const pc = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
        const ps = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
        return Number(pc) * Number(ps);
      } catch { return null; }
    },
    newPairs(): number { return newpairs ? newpairs.rows.size : 0; },
    close(): void {
      try { newpairs?.stop(); } catch { /* ignore */ }
      try { feed.close(); } catch { /* ignore */ }
      try { recorder.close(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------- the loop (pure over the engine + clock)

export interface CollectorLoopOptions {
  intervalMs: number;
  /** How many observation ticks to run; Infinity for the service. */
  ticks: number;
  maintainEveryMs: number;
  /** Soft cap on the whole DB file in bytes; null = off. */
  maxDbBytes: number | null;
  /** task-1504: 'evict' = call engine.enforceCap() every tick and never pause observation (the `maxDbBytes` pause is
   *  skipped). Default 'pause' (the task-1414 behaviour). */
  capMode?: 'pause' | 'evict';
  now: () => number;
  /** Cancellable sleep (resolves early on abort). */
  sleep: (ms: number) => Promise<void>;
  /** True once a stop was requested. */
  aborted: () => boolean;
  onLog?: (s: string) => void;
}

export interface CollectorRunResult {
  ticks: number;
  observePasses: number;
  rowsWritten: number;
  maintainPasses: number;
  cappedTicks: number;
  /** task-1504: ticks where the retention cap evicted old history ('evict' mode). */
  evictions: number;
}

/**
 * Drive the engine. Each tick (after the first waits `intervalMs`): if a disk cap is set and the DB is at/over
 * it, force a retention pass; if it is still over, SKIP observation this tick (so the growth source pauses) but
 * keep running maintenance. Otherwise observe one pass. Maintenance runs at most every `maintainEveryMs`.
 * Never throws out of the loop: an engine error is logged and the loop continues to the next tick.
 */
export async function runCollectorLoop(engine: CollectorEngine, opts: CollectorLoopOptions): Promise<CollectorRunResult> {
  const res: CollectorRunResult = { ticks: 0, observePasses: 0, rowsWritten: 0, maintainPasses: 0, cappedTicks: 0, evictions: 0 };
  let lastMaintain = -Infinity;
  for (let i = 0; i < opts.ticks && !opts.aborted(); i++) {
    if (i > 0) { await opts.sleep(opts.intervalMs); if (opts.aborted()) break; }
    res.ticks++;
    let over = false;
    if (opts.capMode === 'evict') {
      try {
        const c = engine.enforceCap?.() ?? null;
        if (c?.evicted) res.evictions++;
        if (c?.over) opts.onLog?.(`record: DB still at ${(c.usedAfter / 1e6).toFixed(0)} MB used after evicting all but the newest hour (other tables are large); observation continues\n`);
      } catch (e) { opts.onLog?.(`record: retention failed: ${redactSecrets((e as Error).message)}\n`); }
    } else if (opts.maxDbBytes !== null) {
      const b = engine.dbBytes();
      if (b !== null && b >= opts.maxDbBytes) {
        engine.prune();
        const b2 = engine.dbBytes();
        over = b2 !== null && b2 >= opts.maxDbBytes;
        if (over) { res.cappedTicks++; opts.onLog?.(`record: DB at ${(b2! / 1e6).toFixed(0)} MB ≥ cap ${(opts.maxDbBytes / 1e6).toFixed(0)} MB — observation paused this tick (labels + retention still run)\n`); }
      }
    }
    if (!over) {
      try { res.rowsWritten += await engine.observe(); res.observePasses++; } catch (e) { opts.onLog?.(`record: observe failed: ${redactSecrets((e as Error).message)}\n`); }
    }
    const now = opts.now();
    if (now - lastMaintain >= opts.maintainEveryMs) {
      lastMaintain = now;
      try { await engine.maintain(); res.maintainPasses++; } catch (e) { opts.onLog?.(`record: maintain failed: ${redactSecrets((e as Error).message)}\n`); }
    }
  }
  return res;
}

export interface TickLoopOptions {
  /** Spacing between polls (the lane's fast cadence, 5 s). */
  everyMs: number;
  sleep: (ms: number) => Promise<void>;
  aborted: () => boolean;
  onLog?: (s: string) => void;
}

export interface TickLoopResult { polls: number; calls: number; written: number }

/** task-1504: drive the tick lane every `everyMs` until aborted. Never throws (a failed poll is logged). */
export async function runTickLoop(engine: CollectorEngine, opts: TickLoopOptions): Promise<TickLoopResult> {
  const res: TickLoopResult = { polls: 0, calls: 0, written: 0 };
  if (!engine.pollTicks) return res;
  while (!opts.aborted()) {
    try {
      const r = await engine.pollTicks();
      res.polls++; res.calls += r.calls; res.written += r.written;
      if (r.error) opts.onLog?.(`record: tick poll failed: ${redactSecrets(r.error)}\n`);
    } catch (e) { opts.onLog?.(`record: tick poll failed: ${redactSecrets((e as Error).message)}\n`); }
    if (opts.aborted()) break;
    await opts.sleep(opts.everyMs);
  }
  return res;
}

// ---------------------------------------------------------------- the launchd plist (generated, user-level)

export interface PlistOptions {
  label: string;
  /** Absolute node executable. */
  nodePath: string;
  /** Absolute path to the dexterm bin (or the compiled CLI entry). */
  binPath: string;
  intervalMs: number;
  maxDbMb: number;
  /** task-1504: extra `record run` flags (--retention-mb / --retention-days / --focus-ticks), appended verbatim. */
  extraArgs?: string[];
  /** Where the agent writes its stdout/stderr. */
  logPath: string;
  /** The collector's working directory (the checkout, so the source bin resolves its workspaces). */
  workingDir: string;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A user-level LaunchAgent (no sudo). KeepAlive so a crash or a reboot-after-login brings it back, RunAtLoad,
 * ProcessType Background + Nice 10 + Low throttling so it never competes with foreground work, and a
 * ThrottleInterval so a crash-loop cannot spin. It writes to `logPath`. NOTE (documented, and in `install`
 * output): a LaunchAgent does NOT start before the user logs in — this Mac must be logged in for the
 * collector to run; a true pre-login daemon would be a LaunchDaemon under sudo, which this task does not use.
 */
export function renderCollectorPlist(o: PlistOptions): string {
  const args = [o.nodePath, o.binPath, 'record', 'run', '--interval', String(Math.round(o.intervalMs / 1000)), '--max-db-mb', String(o.maxDbMb), ...(o.extraArgs ?? [])];
  const argXml = args.map((a) => `    <string>${esc(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(o.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(o.logPath)}</string>
</dict>
</plist>
`;
}

/** `~/Library/LaunchAgents/<label>.plist` for the invoking user (HOME from env). */
export function plistPath(env: NodeJS.ProcessEnv, label = COLLECTOR_LABEL): string {
  const home = env.HOME || env.USERPROFILE || '';
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

/** The data directory that holds the DB (and the collector log), from the resolved DB path. */
function dataDir(env: NodeJS.ProcessEnv, db?: string): string {
  return dirname(db && db !== ':memory:' ? db : defaultDbPath(env));
}

/** The source bin shim this file ships next to (…/packages/cli/bin/dexterm.mjs). */
function sourceBin(): string {
  return fileURLToPath(new URL('../bin/dexterm.mjs', import.meta.url));
}

// ---------------------------------------------------------------- arg parsing + the command

interface RunArgs {
  intervalMs: number; ticks: number; maintainMs: number; maxDbBytes: number | null; noNewpairs: boolean; db: string | null; verbose: boolean;
  /** task-1504: retention cap in bytes (eviction instead of the pause); null = off. */
  retentionBytes: number | null;
  /** task-1504: age rule for snapshot rows in days; null = the recorder default (90). */
  retentionDays: number | null;
  focusTicks: boolean;
  /** task-1786: absolute path of the focus module (null = none). */
  focusModule: string | null;
  exitProbes: boolean;
}

/** task-1504: the shared `--retention-mb` / `--retention-days` / `--focus-ticks` parser (run + install). */
function parseRetention(t: string, next: () => string | undefined, a: { retentionBytes: number | null; retentionDays: number | null; focusTicks: boolean; focusModule: string | null; exitProbes: boolean }): string | null | undefined {
  if (t === '--focus-ticks') { a.focusTicks = true; return null; }
  if (t === '--exit-probes') { a.exitProbes = true; a.focusTicks = true; return null; }
  if (t === '--focus-module') { const v = next(); if (!v || v.startsWith('--')) return '--focus-module needs a PATH'; a.focusModule = resolve(v); a.focusTicks = true; return null; }
  if (t === '--retention-mb') { const n = Number(next()); if (!Number.isFinite(n) || n < 1) return '--retention-mb needs a number ≥ 1'; a.retentionBytes = Math.round(n * 1_000_000); return null; }
  if (t === '--retention-days') { const n = Number(next()); if (!Number.isFinite(n) || n < 1) return '--retention-days needs a number of days ≥ 1'; a.retentionDays = n; return null; }
  return undefined;
}

export function parseRun(argv: string[]): RunArgs | { error: string } {
  const a: RunArgs = { intervalMs: DEFAULT_INTERVAL_MS, ticks: Infinity, maintainMs: DEFAULT_MAINTAIN_MS, maxDbBytes: DEFAULT_MAX_DB_MB * 1_000_000, noNewpairs: false, db: null, verbose: false, retentionBytes: null, retentionDays: null, focusTicks: false, focusModule: null, exitProbes: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const r = parseRetention(t, () => argv[++i], a);
    if (typeof r === 'string') return { error: r };
    if (r === null) continue;
    if (t === '--verbose' || t === '-v') a.verbose = true;
    else if (t === '--no-newpairs') a.noNewpairs = true;
    else if (t === '--once') a.ticks = 1;
    else if (t === '--ticks') { const n = Number(argv[++i]); if (!Number.isInteger(n) || n < 1) return { error: '--ticks needs an integer ≥ 1' }; a.ticks = n; }
    else if (t === '--interval') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 1) return { error: '--interval needs seconds ≥ 1' }; a.intervalMs = Math.round(n * 1000); }
    else if (t === '--maintain') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 1) return { error: '--maintain needs seconds ≥ 1' }; a.maintainMs = Math.round(n * 1000); }
    else if (t === '--max-db-mb') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 0) return { error: '--max-db-mb needs a number ≥ 0 (0 = no cap)' }; a.maxDbBytes = n === 0 ? null : Math.round(n * 1_000_000); }
    else if (t === '--db') { a.db = argv[++i] ?? null; if (!a.db) return { error: '--db needs a PATH' }; }
    else return { error: `unknown option "${t}"` };
  }
  return a;
}

export const RECORD_USAGE = `dexterm record: keep the history recorder fed with no TUI open (task-1414).

  dexterm record [run] [--interval S] [--ticks N | --once] [--maintain S] [--max-db-mb N] [--retention-mb N] [--retention-days D]
                       [--focus-ticks] [--focus-module PATH] [--exit-probes] [--no-newpairs] [--db PATH] [--verbose]
  dexterm record install   [--interval S] [--max-db-mb N] [--retention-mb N] [--retention-days D] [--focus-ticks]
                           [--focus-module PATH] [--exit-probes] [--load] [--dry-run]
  dexterm record uninstall [--unload]
  dexterm record status    [--db PATH]

run        the collector loop: one keyless feed refresh per --interval (default 60 s) feeds the recorder
           (snapshots + feed membership + new pairs), recorder maintenance (outcome sweeps, labels, retention)
           every --maintain seconds. --max-db-mb is a soft cap (default 1024): above it observation pauses while
           labels + retention keep running. --retention-mb N replaces that pause: the oldest history is evicted
           to stay under N MB and observation never pauses. --retention-days D drops snapshot rows (sweep rows
           too) older than D days (default 90). --focus-ticks samples watchlist / held / candidate / open coins
           every 5-10 s (DexScreener batches of 30, a daily call ceiling) with 1m candles; autotrade backtests
           read them. --focus-module PATH adds the coins an ESM module's focus(now) returns
           ([{ mint, role }], role held | open | candidate | watch) to that lane. --exit-probes asks Jupiter for
           a keyless $50 sell quote of every held focus coin once a minute (exit_probes; quotes only).
           Both imply --focus-ticks. --no-newpairs drops the PumpPortal stream. Ctrl-C stops cleanly
           (labels whatever is due). Requests honour the data layer's rate limits, health gate and sweep budgets.
install    write a user-level launchd LaunchAgent (no sudo) that runs \`record run\`; prints the launchctl
           command. --load also runs launchctl (off by default). --dry-run prints the plist, writes nothing.
uninstall  remove the LaunchAgent plist; --unload also runs launchctl bootout.
status     recorder stats + whether the LaunchAgent is installed + DB size vs the cap.

NOTE: a LaunchAgent does not start before the user logs in on this Mac (it is not a pre-login daemon). The
collector runs only while this user is logged in. Free-tier APIs only; the Helius key is never printed.`;

export async function recordCommand(argv: string[], io: RecordIo, deps: { engine?: CollectorEngine; now?: () => number } = {}): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
  const rest = argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv;
  if (sub === 'help' || argv.includes('--help') || argv.includes('-h')) { io.stdout.write(RECORD_USAGE + '\n'); return 0; }
  if (sub === 'install') return install(rest, io);
  if (sub === 'uninstall') return uninstall(rest, io);
  if (sub === 'status') return status(rest, io);
  if (sub === 'run') return run(rest, io, deps);
  io.stderr.write(`dexterm record: unknown subcommand "${sub}"\n\n${RECORD_USAGE}\n`);
  return 2;
}

async function run(argv: string[], io: RecordIo, deps: { engine?: CollectorEngine; now?: () => number }): Promise<number> {
  const parsed = parseRun(argv);
  if ('error' in parsed) { io.stderr.write(`dexterm record: ${parsed.error}\n\n${RECORD_USAGE}\n`); return 2; }
  const now = deps.now ?? (() => Date.now());
  const dbPath = parsed.db ?? defaultDbPath(io.env);
  if (!deps.engine && dbPath === ':memory:') { io.stderr.write('dexterm record: an in-memory DB keeps no history; give a --db PATH\n'); return 2; }
  if (!deps.engine && !recorderEnabled(io.env, false)) { io.stderr.write('dexterm record: the recorder is disabled (DEXTERM_RECORDER=0); nothing to collect\n'); return 2; }

  // SIGINT/SIGTERM-aware cancellable sleeper (launchd sends SIGTERM to stop the agent).
  // Several loops may sleep at once (the collector + the tick lane), so every sleeper is woken on abort.
  const stop = (() => {
    let aborted = false; const wakes = new Set<() => void>();
    return {
      get aborted() { return aborted; },
      abort() { aborted = true; for (const w of [...wakes]) w(); },
      sleep(ms: number): Promise<void> {
        return new Promise<void>((r) => {
          const done = (): void => { clearTimeout(t); wakes.delete(done); r(); };
          const t = setTimeout(done, ms); t.unref?.();
          wakes.add(done);
        });
      },
    };
  })();

  const log = (s: string): void => io.stderr.write(s);
  // task-1786: the focus module is loaded once, up front; a module that does not load is a startup error (exit 2).
  let extraFocus: (() => Iterable<FocusEntry>) | undefined;
  if (parsed.focusModule) {
    try {
      const mod = await import(pathToFileURL(parsed.focusModule).href) as { focus?: (now: number) => Iterable<FocusEntry> };
      if (typeof mod.focus !== 'function') throw new Error('it exports no focus(now) function');
      const fn = mod.focus;
      extraFocus = () => fn(Date.now());
    } catch (e) { io.stderr.write(`dexterm record: --focus-module ${parsed.focusModule}: ${redactSecrets((e as Error).message)}\n`); return 2; }
  }
  const engine = deps.engine ?? buildLiveEngine(io.env, { dbPath, noNewpairs: parsed.noNewpairs, verbose: parsed.verbose, onLog: log, retentionBytes: parsed.retentionBytes, retentionDays: parsed.retentionDays, focusTicks: parsed.focusTicks, extraFocus, exitProbes: parsed.exitProbes });
  const own = !deps.engine;
  const onSig = (): void => { io.stderr.write('\ndexterm record: stopping…\n'); stop.abort(); };
  if (own) { process.on('SIGINT', onSig); process.on('SIGTERM', onSig); }
  // The sleeps are unref'd; without the PumpPortal socket (--no-newpairs) nothing else would keep the event loop
  // alive between passes and node would exit mid-run (task-1504 smoke). Hold it open until the loops finish.
  const hold = own ? setInterval(() => {}, 1 << 30) : null;
  if (parsed.verbose || parsed.ticks !== Infinity) io.stderr.write(`dexterm record: db ${dbPath} · interval ${Math.round(parsed.intervalMs / 1000)}s · maintain ${Math.round(parsed.maintainMs / 1000)}s · cap ${parsed.maxDbBytes === null ? 'off' : `${Math.round(parsed.maxDbBytes / 1e6)} MB`} · newpairs ${parsed.noNewpairs ? 'off' : 'on'}${parsed.retentionBytes !== null ? ` · retention ${Math.round(parsed.retentionBytes / 1e6)} MB (evict, never pause)` : ''}${parsed.retentionDays !== null ? ` · rows ${parsed.retentionDays} d` : ''} · focus ticks ${parsed.focusTicks ? 'on' : 'off'}${parsed.focusModule ? ` · focus module ${parsed.focusModule}` : ''}${parsed.exitProbes ? ' · exit probes on' : ''}\n`);

  let result: CollectorRunResult;
  let tickRes: TickLoopResult = { polls: 0, calls: 0, written: 0 };
  try {
    let mainDone = false;
    const main = runCollectorLoop(engine, {
      intervalMs: parsed.intervalMs, ticks: parsed.ticks, maintainEveryMs: parsed.maintainMs, maxDbBytes: parsed.maxDbBytes,
      capMode: parsed.retentionBytes !== null ? 'evict' : 'pause',
      now, sleep: (ms) => stop.sleep(ms), aborted: () => stop.aborted, onLog: log,
    }).finally(() => { mainDone = true; if (parsed.ticks !== Infinity) stop.abort(); });
    const lane = parsed.focusTicks && engine.pollTicks
      ? runTickLoop(engine, { everyMs: DEFAULT_TICKS.fastEveryMs, sleep: (ms) => stop.sleep(ms), aborted: () => stop.aborted || mainDone, onLog: log })
      : Promise.resolve(tickRes);
    [result, tickRes] = await Promise.all([main, lane]);
  } finally {
    if (own) { process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig); }
    if (hold) clearInterval(hold);
    engine.close();
  }
  if (parsed.verbose || parsed.ticks !== Infinity) io.stdout.write(`record: ${result.observePasses} observe pass(es), ${result.rowsWritten} snapshot row(s), ${result.maintainPasses} maintenance pass(es)${result.cappedTicks ? `, ${result.cappedTicks} tick(s) paused at the disk cap` : ''}${result.evictions ? `, ${result.evictions} retention eviction(s)` : ''}${tickRes.polls ? `, ${tickRes.polls} focus-tick poll(s) (${tickRes.calls} call(s), ${tickRes.written} tick row(s))` : ''}\n`);
  return 0;
}

function install(argv: string[], io: RecordIo): number {
  let intervalMs = DEFAULT_INTERVAL_MS, maxDbMb = DEFAULT_MAX_DB_MB, load = false, dry = false;
  const ret = { retentionBytes: null as number | null, retentionDays: null as number | null, focusTicks: false, focusModule: null as string | null, exitProbes: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const r = parseRetention(t, () => argv[++i], ret);
    if (typeof r === 'string') { io.stderr.write(`dexterm record: ${r}\n`); return 2; }
    if (r === null) continue;
    if (t === '--load') load = true;
    else if (t === '--dry-run') dry = true;
    else if (t === '--interval') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 1) { io.stderr.write('dexterm record: --interval needs seconds ≥ 1\n'); return 2; } intervalMs = Math.round(n * 1000); }
    else if (t === '--max-db-mb') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 1) { io.stderr.write('dexterm record: --max-db-mb needs a number ≥ 1\n'); return 2; } maxDbMb = n; }
    else { io.stderr.write(`dexterm record install: unknown option "${t}"\n`); return 2; }
  }
  const path = plistPath(io.env);
  const logPath = join(dataDir(io.env), 'collector.log');
  const bin = sourceBin();
  const extraArgs = [
    ...(ret.retentionBytes !== null ? ['--retention-mb', String(Math.round(ret.retentionBytes / 1e6))] : []),
    ...(ret.retentionDays !== null ? ['--retention-days', String(ret.retentionDays)] : []),
    ...(ret.focusTicks ? ['--focus-ticks'] : []),
    ...(ret.focusModule ? ['--focus-module', ret.focusModule] : []),
    ...(ret.exitProbes ? ['--exit-probes'] : []),
  ];
  const plist = renderCollectorPlist({ label: COLLECTOR_LABEL, nodePath: process.execPath, binPath: bin, intervalMs, maxDbMb, extraArgs, logPath, workingDir: resolve(dirname(bin), '..', '..', '..') });
  if (dry) { io.stdout.write(plist); io.stderr.write(`\ndexterm record: dry run — would write ${path}\n`); return 0; }
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(path, plist);
  io.stdout.write(`wrote ${path}\nlog     ${logPath}\n\nEnable it (user-level, no sudo):\n  launchctl bootstrap gui/$(id -u) ${path}\n  launchctl kickstart -k gui/$(id -u)/${COLLECTOR_LABEL}\nStop/remove it:  dexterm record uninstall --unload\n\nNOTE: a LaunchAgent does NOT start before you log in on this Mac; the collector runs only while logged in.\n`);
  if (load) return runLaunchctl(['bootstrap', `gui/${process.getuid?.() ?? 0}`, path], io);
  io.stderr.write('dexterm record: plist written but NOT loaded (pass --load, or run the launchctl command above) once you have checked it.\n');
  return 0;
}

function uninstall(argv: string[], io: RecordIo): number {
  const unload = argv.includes('--unload');
  const path = plistPath(io.env);
  if (unload) runLaunchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${COLLECTOR_LABEL}`], io);
  if (existsSync(path)) { rmSync(path, { force: true }); io.stdout.write(`removed ${path}\n`); }
  else io.stdout.write(`no LaunchAgent at ${path}\n`);
  return 0;
}

function status(argv: string[], io: RecordIo): number {
  let db: string | null = null;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--db') { db = argv[++i] ?? null; if (!db) { io.stderr.write('dexterm record: --db needs a PATH\n'); return 2; } } }
  const path = plistPath(io.env);
  const installed = existsSync(path);
  const dbPath = db ?? defaultDbPath(io.env);
  io.stdout.write(`LaunchAgent     ${installed ? `installed (${path})` : 'not installed (dexterm record install)'}\n`);
  io.stdout.write(`service note    LaunchAgents do not start before login; the collector runs only while logged in\n`);
  if (dbPath === ':memory:') { io.stdout.write('recorder        in-memory DB (no history)\n'); return 0; }
  let rec: Recorder | null = null;
  try {
    rec = new Recorder({ path: dbPath, enabled: false });
    const s = rec.stats();
    const when = (t: number | null): string => (t === null ? '—' : new Date(t).toISOString());
    io.stdout.write([
      `db              ${dbPath} (${s.dbBytes === null ? '—' : `${(s.dbBytes / 1e6).toFixed(1)} MB`})`,
      `snapshots       ${s.snapshots} (live ${s.live}, sweep ${s.sweep}, t0 anchors ${s.t0})`,
      `outcomes        ${s.outcomes}${s.outcomes ? ` (${Object.entries(s.outcomesByLabel).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`,
      `sweeps          ${s.sweeps} runs · ${s.sweepCallsToday} DexScreener calls today`,
      `focus ticks     ${s.ticks} rows · ${s.candles} 1m candles · ${s.tickCallsToday} calls today`,
      `span            ${when(s.oldestT)} → ${when(s.newestT)}`,
    ].join('\n') + '\n');
  } catch (e) {
    io.stderr.write(`dexterm record status: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally { rec?.close(); }
  return 0;
}

/** Run launchctl best-effort (only on --load/--unload). Never throws: a failure is reported, the plist stays. */
function runLaunchctl(args: string[], io: RecordIo): number {
  try {
    const r = spawnSync('launchctl', args, { stdio: 'inherit' });
    if (r.status !== 0) { io.stderr.write(`dexterm record: launchctl ${args[0]} exited ${r.status ?? 'null'}\n`); return 1; }
    io.stdout.write(`launchctl ${args[0]} ok\n`);
    return 0;
  } catch (e) {
    io.stderr.write(`dexterm record: launchctl failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
