// dexterm autotrade — the always-on service: lock, heartbeat, stop marker, crash-loop guard and the `ensure`
// decision (0.2.0 card B, AUTOTRADE-SPEC §7.4 / AT-10). Mode-agnostic: the service hosts `run --all` and never
// decides paper or real itself.
//
// Shape (one per machine and DEXTERM_HOME):
//   OS scheduler (LaunchAgent / systemd user timer / scheduled task), every 60 s and at login
//     └─ `dexterm autotrade service ensure`   exits at once when the heartbeat is fresh; otherwise starts the service
//          └─ `dexterm autotrade service run`  detached: service lock + heartbeat every 10 s + guard + the fleet
//
// Files under $DEXTERM_HOME/autotrade/service/:
//   service.lock    {pid, bootAt, startedAt}: a stale lock is reclaimed only when that pid is dead (or from an older boot)
//   heartbeat.json  dexterm-autotrade-service/1: state, fleet id, guard states; rewritten every 10 s; `stopped` on a
//                   clean exit (anything else with a dead pid is a crash)
//   STOP            the stop marker: `service stop`, a Telegram / Q-screen / CLI stop of the fleet, or a plain `touch`.
//                   A clean stop stays stopped: `ensure` does nothing until `service start` removes it.
//   starts.json     the crash-loop guard: every start after a crash, and the give-up record (`attention`)
//   state.json      the fleet the service is running (recovery after a crash reads its ledgers, service-recover.ts)
// Logs: $DEXTERM_HOME/autotrade/logs/service.log (+ .1), size-capped (BoundedLog).
//
// Crash-loop guard: a start that follows a crash waits a backoff (0, 0, 1, 2, 4 min for the 1st..5th crash in an
// hour); the 6th crash within an hour writes `attention`, sends ONE notification and leaves the service down until
// `dexterm autotrade service status --clear`. A clean stop and a manual `service start` never count.
//
// Nothing here holds a key, signs, touches a wallet or the network, and no model reaches any of it.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './ledger.ts';

export const SERVICE_SCHEMA = 'dexterm-autotrade-service/1';
export const SERVICE_HEARTBEAT_MS = 10_000;
/** `ensure` treats a heartbeat older than this as "not running" (three missed beats). */
export const SERVICE_STALE_MS = 35_000;
/** A live pid whose heartbeat is this old is hung: `ensure` ends it so the next tick restarts it. */
export const SERVICE_HUNG_MS = 180_000;
export const CRASH_WINDOW_MS = 60 * 60_000;
/** Crash restarts allowed in CRASH_WINDOW_MS; the next one gives up. */
export const MAX_CRASH_RESTARTS = 5;

export const serviceDir = (home: string): string => join(home, 'autotrade', 'service');
export const serviceLogDir = (home: string): string => join(home, 'autotrade', 'logs');
export const serviceLockPath = (home: string): string => join(serviceDir(home), 'service.lock');
export const serviceHeartbeatPath = (home: string): string => join(serviceDir(home), 'heartbeat.json');
export const serviceStopPath = (home: string): string => join(serviceDir(home), 'STOP');
export const serviceStartsPath = (home: string): string => join(serviceDir(home), 'starts.json');
export const serviceStatePath = (home: string): string => join(serviceDir(home), 'state.json');
export const serviceLogPath = (home: string): string => join(serviceLogDir(home), 'service.log');

const mkdirs = (home: string): void => { mkdirSync(serviceDir(home), { recursive: true, mode: 0o700 }); };
const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; } };

export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
/** This boot's start, rounded to the minute (a pid from an older boot is never this process). */
export const bootAt = (): number => Math.round((Date.now() - uptime() * 1000) / 60_000) * 60_000;

// ───────────────────────────── the lock ─────────────────────────────

export interface ServiceLock { pid: number; bootAt: number; startedAt: number }
export type ServiceLockResult = { ok: true; lock: ServiceLock; reclaimed: ServiceLock | null } | { ok: false; holder: ServiceLock };

export interface LockDeps { pid?: number; alive?: (pid: number) => boolean; boot?: number; now?: number }

/** Take the service lock (O_EXCL). A holder is stale only when its pid is dead or it is from an older boot. */
export function acquireServiceLock(home: string, d: LockDeps = {}): ServiceLockResult {
  mkdirs(home);
  const path = serviceLockPath(home);
  const alive = d.alive ?? pidAlive;
  const lock: ServiceLock = { pid: d.pid ?? process.pid, bootAt: d.boot ?? bootAt(), startedAt: d.now ?? Date.now() };
  let reclaimed: ServiceLock | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${JSON.stringify(lock)}\n`);
      closeSync(fd);
      return { ok: true, lock, reclaimed };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const held = readJson<ServiceLock>(path);
    if (held && typeof held.pid === 'number' && alive(held.pid) && Math.abs((held.bootAt ?? 0) - lock.bootAt) <= 5 * 60_000) return { ok: false, holder: held };
    reclaimed = held;
    rmSync(path, { force: true });
  }
  throw new Error(`could not take ${path}`);
}

export function releaseServiceLock(home: string, pid = process.pid): void {
  const held = readJson<ServiceLock>(serviceLockPath(home));
  if (held && held.pid === pid) rmSync(serviceLockPath(home), { force: true });
}

/** The lock holder when its pid is alive (and from this boot), else null. */
export function liveServiceHolder(home: string, alive: (pid: number) => boolean = pidAlive, boot = bootAt()): ServiceLock | null {
  const held = readJson<ServiceLock>(serviceLockPath(home));
  if (!held || typeof held.pid !== 'number' || !alive(held.pid)) return null;
  return Math.abs((held.bootAt ?? 0) - boot) <= 5 * 60_000 ? held : null;
}

// ───────────────────────────── heartbeat ─────────────────────────────

export type ServiceRunState = 'starting' | 'running' | 'stopping' | 'stopped';

export interface GuardStateView { id: string; effect: 'stop' | 'pause-entries' | 'notice'; detail: string; since: number }

export interface ServiceHeartbeat {
  schema: typeof SERVICE_SCHEMA;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  state: ServiceRunState;
  /** The fleet run the service hosts (null before it starts or after it ends). */
  fleetId: string | null;
  /** Why the service ended (a clean exit only). */
  endReason?: string | null;
  /** Active guard states (service-guard.ts). */
  guard: GuardStateView[];
  /** Paper positions the service carried over from a crashed run at its start. */
  resumed?: { positions: number; takenCoins: number } | null;
  /** The age of the newest market tick any strategy saw, ms (null before the first). */
  dataAgeMs?: number | null;
}

export function writeServiceHeartbeat(home: string, hb: ServiceHeartbeat): void {
  mkdirs(home);
  writeJsonAtomic(serviceHeartbeatPath(home), hb);
}

export function readServiceHeartbeat(home: string): ServiceHeartbeat | null {
  const d = readJson<ServiceHeartbeat>(serviceHeartbeatPath(home));
  return d && d.schema === SERVICE_SCHEMA && typeof d.pid === 'number' && typeof d.heartbeatAt === 'number' ? d : null;
}

// ───────────────────────────── stop marker ─────────────────────────────

export type StopBy = 'cli' | 'tui' | 'chat' | 'fleet' | 'uninstall' | 'file';
export interface StopMarker { at: number; by: StopBy; reason: string }

export function writeStopMarker(home: string, by: StopBy, reason: string, now = Date.now()): StopMarker {
  mkdirs(home);
  const m: StopMarker = { at: now, by, reason: reason.slice(0, 200) };
  writeJsonAtomic(serviceStopPath(home), m);
  return m;
}

/** The stop marker, or null. A file that is not our JSON (a plain `touch`) is still a stop. */
export function readStopMarker(home: string): StopMarker | null {
  const p = serviceStopPath(home);
  if (!existsSync(p)) return null;
  const d = readJson<Partial<StopMarker>>(p);
  if (d && typeof d.at === 'number') return { at: d.at, by: (d.by ?? 'file') as StopBy, reason: typeof d.reason === 'string' ? d.reason : 'stop' };
  let at = 0;
  try { at = statSync(p).mtimeMs; } catch { /* raced */ }
  return { at, by: 'file', reason: 'the STOP file is present' };
}

export const clearStopMarker = (home: string): void => { rmSync(serviceStopPath(home), { force: true }); };

// ───────────────────────────── crash-loop guard ─────────────────────────────

export interface StartsDoc {
  /** Starts that followed a crash (epoch ms), the last hour only. */
  crashStarts: number[];
  /** The last start of any kind. */
  lastStartAt: number | null;
  /** Set when the guard gave up; the service stays down until `status --clear`. */
  attention: { at: number; why: string; notified: boolean } | null;
  /** The last "service was down" notification (one an hour at most; the give-up has its own). */
  downNotifiedAt: number | null;
}

const EMPTY_STARTS: StartsDoc = { crashStarts: [], lastStartAt: null, attention: null, downNotifiedAt: null };

export function readStarts(home: string): StartsDoc {
  const d = readJson<Partial<StartsDoc>>(serviceStartsPath(home));
  if (!d) return { ...EMPTY_STARTS, crashStarts: [] };
  return {
    crashStarts: Array.isArray(d.crashStarts) ? d.crashStarts.filter((t): t is number => typeof t === 'number') : [],
    lastStartAt: typeof d.lastStartAt === 'number' ? d.lastStartAt : null,
    attention: d.attention && typeof d.attention.at === 'number' ? { at: d.attention.at, why: String(d.attention.why ?? ''), notified: !!d.attention.notified } : null,
    downNotifiedAt: typeof d.downNotifiedAt === 'number' ? d.downNotifiedAt : null,
  };
}

export function writeStarts(home: string, d: StartsDoc): void { mkdirs(home); writeJsonAtomic(serviceStartsPath(home), d); }

/** Wait before the n-th crash restart within the window (1-based): 0, 0, 1, 2, 4 minutes. */
export function crashBackoffMs(n: number): number { return n <= 2 ? 0 : Math.min(15, 2 ** (n - 3)) * 60_000; }

/** `service status --clear`: forget the crash history and lift the give-up. */
export function clearAttention(home: string): StartsDoc {
  const d = { ...readStarts(home), crashStarts: [], attention: null };
  writeStarts(home, d);
  return d;
}

// ───────────────────────────── the ensure decision ─────────────────────────────

export interface EnsureInput {
  now: number;
  /** The live lock holder (pid alive, this boot), or null. */
  holder: ServiceLock | null;
  heartbeat: ServiceHeartbeat | null;
  stop: StopMarker | null;
  starts: StartsDoc;
  /** The panic file's reason when engaged. */
  panic: string | null;
}

export type EnsureDecision =
  | { action: 'noop'; why: string }
  | { action: 'kill-hung'; pid: number; why: string }
  | { action: 'wait'; why: string; untilMs: number }
  | { action: 'give-up'; why: string; notify: boolean }
  | { action: 'start'; crashed: boolean; why: string; notifyDown: boolean };

/** True when the last run did not end cleanly (a heartbeat that is not `stopped`, with no live holder). */
export function lastRunCrashed(hb: ServiceHeartbeat | null): boolean { return !!hb && hb.state !== 'stopped'; }

/**
 * What one scheduler tick does. Pure: the caller reads the files and carries the action out (startService,
 * the kill, the notification, writeStarts).
 */
export function ensureDecision(i: EnsureInput): EnsureDecision {
  if (i.holder) {
    const age = i.heartbeat && i.heartbeat.pid === i.holder.pid ? i.now - i.heartbeat.heartbeatAt : i.now - i.holder.startedAt;
    if (age <= SERVICE_STALE_MS) return { action: 'noop', why: `running (pid ${i.holder.pid}, heartbeat ${Math.round(age / 1000)} s old)` };
    if (age >= SERVICE_HUNG_MS) return { action: 'kill-hung', pid: i.holder.pid, why: `pid ${i.holder.pid} is alive but its heartbeat is ${Math.round(age / 1000)} s old (hung)` };
    return { action: 'noop', why: `pid ${i.holder.pid} is alive; heartbeat ${Math.round(age / 1000)} s old (starting or busy)` };
  }
  if (i.stop) return { action: 'noop', why: `stopped (${i.stop.reason}); \`dexterm autotrade service start\` starts it again` };
  if (i.starts.attention) return { action: 'give-up', why: i.starts.attention.why, notify: !i.starts.attention.notified };
  if (i.panic) return { action: 'noop', why: `the panic switch is engaged (${i.panic}); nothing starts until \`dexterm wallet resume\`` };
  const crashed = lastRunCrashed(i.heartbeat);
  if (!crashed) return { action: 'start', crashed: false, why: i.heartbeat ? 'the service is not running' : 'first start', notifyDown: false };
  const recent = i.starts.crashStarts.filter((t) => i.now - t < CRASH_WINDOW_MS);
  if (recent.length >= MAX_CRASH_RESTARTS) {
    return { action: 'give-up', why: `crash loop: ${recent.length + 1} crashes within an hour; the service stays down until \`dexterm autotrade service status --clear\``, notify: true };
  }
  const wait = crashBackoffMs(recent.length + 1);
  const last = recent.length ? Math.max(...recent) : 0;
  if (last && i.now - last < wait) return { action: 'wait', why: `crash ${recent.length + 1} within the hour: backing off ${Math.round(wait / 60_000)} min`, untilMs: last + wait };
  const notifyDown = !i.starts.downNotifiedAt || i.now - i.starts.downNotifiedAt >= CRASH_WINDOW_MS;
  return { action: 'start', crashed: true, why: `the last run ended without a clean stop (pid ${i.heartbeat!.pid}); restarting`, notifyDown };
}

/** Record what a decision did in starts.json (the caller does the process work). */
export function applyEnsure(home: string, d: EnsureDecision, now: number): StartsDoc {
  const s = readStarts(home);
  s.crashStarts = s.crashStarts.filter((t) => now - t < CRASH_WINDOW_MS);
  if (d.action === 'start') {
    s.lastStartAt = now;
    if (d.crashed) s.crashStarts.push(now);
    if (d.notifyDown) s.downNotifiedAt = now;
  } else if (d.action === 'give-up') {
    s.attention = { at: s.attention?.at ?? now, why: d.why, notified: true };
  }
  writeStarts(home, s);
  return s;
}

// ───────────────────────────── service state (for recovery) ─────────────────────────────

export interface ServiceStateDoc { fleetId: string | null; startedAt: number; pid: number }

export function writeServiceState(home: string, d: ServiceStateDoc): void { mkdirs(home); writeJsonAtomic(serviceStatePath(home), d); }
export function readServiceState(home: string): ServiceStateDoc | null {
  const d = readJson<ServiceStateDoc>(serviceStatePath(home));
  return d && typeof d.startedAt === 'number' ? { fleetId: typeof d.fleetId === 'string' ? d.fleetId : null, startedAt: d.startedAt, pid: Number(d.pid) || 0 } : null;
}

// ───────────────────────────── the bounded log ─────────────────────────────

export const LOG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * An append-only log capped at maxBytes: past the cap the file moves to `.1` (replacing the older one) and a new
 * file starts, so the log never holds more than about 2 × maxBytes. Each line is stamped; write errors are swallowed
 * (a full disk must never stop the exits).
 */
export class BoundedLog {
  readonly path: string;
  private readonly max: number;
  private size: number;
  constructor(path: string, maxBytes = LOG_MAX_BYTES) {
    this.path = path;
    this.max = maxBytes;
    try { mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 }); } catch { /* reported on write */ }
    try { this.size = statSync(path).size; } catch { this.size = 0; }
    if (this.size >= this.max) this.rotate();
  }
  private rotate(): void {
    try { renameSync(this.path, `${this.path}.1`); } catch { /* nothing to move */ }
    this.size = 0;
  }
  line(s: string, now = Date.now()): void {
    const text = `${new Date(now).toISOString()} ${s.replace(/\n+$/, '')}\n`;
    const n = Buffer.byteLength(text);
    if (this.size + n > this.max) this.rotate();
    try { appendFileSync(this.path, text, { mode: 0o600 }); this.size += n; } catch { /* never the service's problem */ }
  }
  /** A stream-like face for code that writes chunks (the fleet's stdout / stderr). */
  writer(prefix = ''): { write(s: string): boolean } {
    let buf = '';
    return {
      write: (s: string) => {
        buf += s;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { this.line(prefix + buf.slice(0, i)); buf = buf.slice(i + 1); }
        if (buf.length > 8192) { this.line(prefix + buf); buf = ''; }
        return true;
      },
    };
  }
}

/** The last n lines of the service log (and the rotated one before it when short). */
export function tailServiceLog(home: string, n = 50): string[] {
  const read = (p: string): string[] => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const cur = read(serviceLogPath(home));
  if (cur.length >= n) return cur.slice(-n);
  return [...read(`${serviceLogPath(home)}.1`), ...cur].slice(-n);
}
