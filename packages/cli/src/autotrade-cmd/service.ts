// `dexterm autotrade service …` (0.2.0 card B, AUTOTRADE-SPEC §7.4 / AT-10): the always-on service.
//
//   install [--dry-run] [--load] [--platform P]   show (and write) the OS job that runs `service ensure` every minute
//   uninstall [--flatten --yes] [--force]         stop, unload, remove exactly what install wrote
//   ensure                                        one scheduler tick: start the service when it is not running
//   run                                           the service itself (foreground; what ensure starts, detached)
//   start | stop [--flatten --yes] [--wait SEC]   start it now / stop it (a clean stop stays stopped)
//   status [--json] [--clear]                     heartbeat, guard, crash-loop state, strategies; --clear lifts a give-up
//   logs [-n N]                                   the service log
// `--home PATH` on any of them = DEXTERM_HOME for that call (the installers pass it for a non-default home).
//
// The service hosts `run --all` (every strategy of autotrade.json, the existing fleet: its own lock, rendezvous,
// control file, panic file, per-strategy controls and Q screen) and adds, around it: the service lock and heartbeat,
// the guard aggregator (service-guard.ts: pause new entries on disk / load / busy process / stale data; notices for
// allowance, day caps, recorder health, halted strategies), crash recovery (service-recover.ts: positions a crashed
// run left open are adopted and keep their exits; coins it took are never bought again), notifications through the
// paired Telegram bot (and the bot's /stop /pause controls), resource limits (nice 10, a 512 MB heap cap, bounded logs).
// Every stop halts new entries at the next step and keeps the exits running until nothing is held (flatten sells).
// A stop from anywhere (this command, the Q screen, the bot, `dexterm autotrade stop`, the panic file, a `touch` of
// the STOP file) leaves the service stopped until `service start`; a crash restarts it on the next tick.
//
// Mode-agnostic: the service never chooses paper or real; the strategies and their own gates do.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, setPriority, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dextermHome } from '@dexterm/custom';
import { KillSwitch, defaultDbPath } from '@dexterm/data';
import {
  BoundedLog, INSTALL_MANIFEST_SCHEMA, PaperPort, RESUME_TAKEN_RULE, SERVICE_HEARTBEAT_MS, SERVICE_SCHEMA, ServiceGuard, TelegramConnector, TelegramService,
  activeRunner, acquireServiceLock, applyEnsure, clearAttention, clearStopMarker, encode, ensureDecision, fileSha, guardConfigFrom, guardNoticeText,
  installManifestPath, installPlan, lastRunCrashed, liveServiceHolder, loadConnectors, loadRunnerConfig, readFleetStatus, readServiceHeartbeat, readServiceState,
  readStarts, readStopMarker, recoverFleet, releaseServiceLock, requestControl, runnerRendezvousPath, secretStore, serviceLabel, serviceLogDir, serviceLogPath,
  serviceStopPath, strategyTaggedHooks, tailServiceLog, writeServiceHeartbeat, writeServiceState, writeStopMarker,
  type EnsureDecision, type FleetMemberSpec, type FleetStatus, type GuardInputs, type InstallManifest, type InstallPlan, type InstallSpec, type Position,
  type RunnerState, type ServiceHeartbeat, type ServicePlatform, type ServiceRunState, type VetFn,
} from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';
import { fleetRunCmd, type FleetRunOverrides } from './fleet.ts';

export const SERVICE_USAGE = 'dexterm autotrade service install|uninstall|ensure|run|start|stop|status|logs [--home PATH]';
const SUBS = ['install', 'uninstall', 'ensure', 'run', 'start', 'stop', 'status', 'logs'] as const;

/** The heap cap of the started service (a leak ends in a crash and a restart, never in a swapped machine). */
export const SERVICE_HEAP_MB = 512;

/** Test seams. */
export interface ServiceDeps {
  now?: () => number;
  /** Start `service run` detached (ensure / start). */
  spawnRun?: (home: string, io: AutotradeIo) => number | null;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  /** Deliver a notification (default: the paired Telegram bot, when there is one). */
  notify?: (home: string, text: string) => Promise<void>;
  /** Run a scheduler command (install --load / uninstall). */
  exec?: (cmd: string[]) => { status: number | null; out: string };
  /** `service run`: the fleet (default fleetRunCmd) and its overrides. */
  fleet?: (argv: string[], io: AutotradeIo, over: FleetRunOverrides) => Promise<number>;
  fleetOver?: FleetRunOverrides;
  killSwitch?: { engaged(): { reason: string } | null };
  /** Guard inputs the service collects (tests fix them). */
  probe?: Partial<Pick<GuardInputs, 'freeGb' | 'load1m' | 'busy' | 'recorder'>>;
  /** Heartbeat / guard period (default 10 s). */
  beatMs?: number;
  /** Platform for install (default process.platform). */
  platform?: ServicePlatform;
  userHome?: string;
}

const homeOf = (io: AutotradeIo): string => dextermHome(io.env);
const defaultHomeOf = (io: AutotradeIo): string => dextermHome({ ...io.env, DEXTERM_HOME: '' });
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function serviceCmd(argv: string[], io0: AutotradeIo, deps: ServiceDeps = {}): Promise<number> {
  const [sub, ...rest0] = argv;
  // --home PATH: DEXTERM_HOME for this call only.
  const rest: string[] = [];
  let io = io0;
  for (let i = 0; i < rest0.length; i++) {
    if (rest0[i] === '--home') {
      const h = rest0[++i];
      if (!h) { io0.stderr.write('dexterm autotrade service: --home needs a PATH\n'); return 2; }
      io = { ...io0, env: { ...io0.env, DEXTERM_HOME: resolve(h) } };
    } else rest.push(rest0[i]);
  }
  if (!sub || !(SUBS as readonly string[]).includes(sub)) { io.stderr.write(`usage: ${SERVICE_USAGE}\n${HELP}`); return sub === undefined || sub === 'help' || sub === '--help' ? 0 : 2; }
  switch (sub) {
    case 'ensure': return ensureCmd(rest, io, deps);
    case 'run': return runServiceCmd(rest, io, deps);
    case 'start': return startCmd(rest, io, deps);
    case 'stop': return stopServiceCmd(rest, io, deps);
    case 'status': return statusCmd(rest, io, deps);
    case 'logs': return logsCmd(rest, io);
    case 'install': return installCmd(rest, io, deps);
    case 'uninstall': return uninstallCmd(rest, io, deps);
  }
  return 2;
}

const HELP = `
  install     show the OS job (macOS LaunchAgent, Linux systemd user timer, Windows scheduled task) that runs
              \`service ensure\` every minute and at login; --dry-run writes nothing, --load also loads it
  uninstall   stop the service, unload the job and remove exactly the files install wrote; refuses while positions
              are open unless --flatten --yes
  ensure      one scheduler tick: nothing when the service is running or was stopped; otherwise start it
  run         the service in the foreground (\`ensure\` starts this detached)
  start       start it now (lifts a stop)
  stop        no new entries now; open positions keep their exits until closed (--flatten --yes sells them);
              it stays stopped until \`service start\`
  status      heartbeat, guard states, crash-loop state and the strategies; --clear lifts a crash-loop give-up
  logs        the end of the service log (-n N lines)
`;

// ───────────────────────────── notifications ─────────────────────────────

/** Send one plain-text line to every chat paired with the notify tier of the user's own bot; silent when none. */
export async function telegramNotify(home: string, text: string): Promise<void> {
  const r = loadConnectors(home);
  if (!r.ok) return;
  const t = r.config.telegram;
  if (!t.enabled || !t.tiers.includes('notify')) return;
  const chats = [...new Set(t.allow.filter((a) => a.tiers.includes('notify')).map((a) => a.chatId))];
  if (!chats.length) return;
  const token = t.secretStore ? secretStore(t.secretStore, home).get() : null;
  if (!token) return;
  const c = new TelegramConnector({ token: () => token });
  for (const chatId of chats) {
    try { await Promise.race([c.send({ chatId }, { kind: 'text', badge: null, lines: [text] }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000).unref())]); } catch { /* the log has it */ }
  }
}

function notifier(home: string, deps: ServiceDeps, log?: BoundedLog): (text: string) => Promise<void> {
  const send = deps.notify ?? telegramNotify;
  return async (text) => {
    log?.line(`notify: ${text}`);
    try { await send(home, text); } catch (e) { log?.line(`notify failed: ${errMsg(e)}`); }
  };
}

// ───────────────────────────── ensure ─────────────────────────────

/** The source bin this file ships next to (…/packages/cli/bin/dexterm.mjs). */
export const sourceBin = (): string => fileURLToPath(new URL('../../bin/dexterm.mjs', import.meta.url));

/** Start `service run` detached, its stdout/stderr (a crash's stack) in logs/service.out; returns the pid. */
export function spawnServiceRun(home: string, io: AutotradeIo): number | null {
  const dir = serviceLogDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const outPath = join(dir, 'service.out');
  try { if (statSync(outPath).size > 1024 * 1024) renameSync(outPath, `${outPath}.1`); } catch { /* none yet */ }
  const fd = openSync(outPath, 'a', 0o600);
  const env = { ...io.env, DEXTERM_HOME: home, NODE_OPTIONS: `${io.env.NODE_OPTIONS ?? ''} --max-old-space-size=${SERVICE_HEAP_MB}`.trim() };
  const child = spawn(process.execPath, [sourceBin(), 'autotrade', 'service', 'run', '--home', home], { detached: true, stdio: ['ignore', fd, fd], env, cwd: resolve(dirname(sourceBin()), '..', '..', '..'), windowsHide: true });
  child.unref();
  closeSync(fd);
  return child.pid ?? null;
}

async function ensureCmd(argv: string[], io: AutotradeIo, deps: ServiceDeps): Promise<number> {
  const { opts } = parseArgs(argv, ['json', 'quiet']);
  const home = homeOf(io);
  const now = (deps.now ?? Date.now)();
  const panic = (deps.killSwitch ?? new KillSwitch()).engaged();
  const d = ensureDecision({ now, holder: liveServiceHolder(home), heartbeat: readServiceHeartbeat(home), stop: readStopMarker(home), starts: readStarts(home), panic: panic ? panic.reason : null });
  const log = new BoundedLog(serviceLogPath(home));
  const notify = notifier(home, deps, log);
  // The scheduler appends this command's output to logs/tick.log every minute: keep it bounded too.
  const tick = join(serviceLogDir(home), 'tick.log');
  try { if (statSync(tick).size > 1024 * 1024) renameSync(tick, `${tick}.1`); } catch { /* none yet */ }
  const say = (s: string) => { if (opts.json) return; if (d.action !== 'noop' || !opts.quiet) io.stdout.write(`${new Date(now).toISOString()} ${s}\n`); };
  let pid: number | null = null;
  if (d.action === 'kill-hung') {
    log.line(`ensure: ${d.why}; ending it (the next tick restarts it)`);
    try { (deps.kill ?? process.kill.bind(process))(d.pid, 'SIGKILL'); } catch (e) { log.line(`ensure: kill failed: ${errMsg(e)}`); }
    await notify(`autotrade service · DOWN · it stopped answering (pid ${d.pid}); restarting it`);
  } else if (d.action === 'give-up') {
    applyEnsure(home, d, now);
    if (d.notify) { log.line(`ensure: ${d.why}`); await notify(`autotrade service · CRASH LOOP · ${d.why}`); }
  } else if (d.action === 'start') {
    applyEnsure(home, d, now);
    log.line(`ensure: ${d.why}`);
    pid = (deps.spawnRun ?? spawnServiceRun)(home, io);
    log.line(`ensure: started the service (pid ${pid ?? '?'})`);
    if (d.crashed && d.notifyDown) await notify('autotrade service · DOWN · it ended without a clean stop; restarting it (open paper positions are carried over)');
  }
  if (opts.json) io.stdout.write(`${JSON.stringify({ ...d, pid })}\n`);
  else say(`${d.action}: ${d.why}${pid ? ` (pid ${pid})` : ''}`);
  return d.action === 'give-up' ? 1 : 0;
}

async function startCmd(argv: string[], io: AutotradeIo, deps: ServiceDeps): Promise<number> {
  const home = homeOf(io);
  const had = readStopMarker(home);
  clearStopMarker(home);
  if (had) io.stdout.write(`lifted the stop (${had.reason})\n`);
  const st = readStarts(home);
  if (st.attention) { io.stderr.write(`the service gave up after a crash loop (${st.attention.why}). Look at \`dexterm autotrade service logs\`, then \`dexterm autotrade service status --clear\`.\n`); return 1; }
  return ensureCmd(argv, io, deps);
}

// ───────────────────────────── stop ─────────────────────────────

async function stopServiceCmd(argv: string[], io: AutotradeIo, deps: ServiceDeps): Promise<number> {
  const { opts } = parseArgs(argv, ['flatten', 'yes', 'json']);
  const home = homeOf(io);
  if (opts.flatten && !opts.yes) { io.stderr.write('dexterm autotrade service stop --flatten sells every open paper position at its next tick: add --yes to confirm\n'); return 2; }
  const r = await stopService(io, opts.flatten ? 'flatten' : 'stop', 'cli', waitOf(opts.wait));
  if (opts.json) { io.stdout.write(`${JSON.stringify(r)}\n`); return 0; }
  io.stdout.write(`${r.lines.join('\n')}\n`);
  void deps;
  return 0;
}

const waitOf = (v: string | true | undefined): number => { const n = typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? Math.min(n, 120) : 5; };

/** The STOP marker (a clean stop stays stopped) + a soft stop / flatten of the running fleet. */
export async function stopService(io: AutotradeIo, action: 'stop' | 'flatten', by: 'cli' | 'uninstall', waitSec: number): Promise<{ marker: boolean; runId: string | null; positions: number; lines: string[] }> {
  const home = homeOf(io);
  writeStopMarker(home, by, by === 'uninstall' ? 'uninstall' : `\`dexterm autotrade service ${action === 'flatten' ? 'stop --flatten' : 'stop'}\``);
  const lines = ['service stop recorded: it stays stopped until `dexterm autotrade service start`'];
  const r = activeRunner(home);
  if (!r) { lines.push('no strategies are running; nothing else to do'); return { marker: true, runId: null, positions: 0, lines }; }
  const { sendControl } = await import('./stop.ts');
  const res = await sendControl(io, action, waitSec, r);
  if ('error' in res) { lines.push(`the strategies did not take the request: ${res.error}`); return { marker: true, runId: r.runId, positions: r.positions, lines }; }
  lines.push(res.acknowledged
    ? `✓ ${action === 'flatten' ? 'flattening' : 'halted'}: no new entries${res.positions ? `; ${res.positions} open position${res.positions === 1 ? '' : 's'} ${action === 'flatten' ? 'sell at the next tick' : 'keep their exits until closed (`--flatten --yes` sells now)'}` : ''}; the service ends once nothing is held`
    : 'requested; the strategies read it on their next step (`dexterm autotrade service status`)');
  return { marker: true, runId: r.runId, positions: res.positions, lines };
}

// ───────────────────────────── run ─────────────────────────────

const FLEET_PASS = ['--replay', '--ms-per-tick', '--sol-usd', '--model', '--max-minutes', '--config'];

export const SERVICE_CONFIG_SCHEMA = 'dexterm-autotrade-service-config/1';
export const serviceConfigPath = (home: string): string => join(home, 'autotrade', 'service.json');

/**
 * $DEXTERM_HOME/autotrade/service.json: `{ "schema": "dexterm-autotrade-service-config/1", "runArgs": [...] }`, the
 * `run --all` flags a scheduler-started service uses (only --stub, --replay, --ms-per-tick, --sol-usd, --model,
 * --config, --max-minutes; anything else is refused and logged). Never --live: the strategies' own modes decide.
 */
export function readServiceConfig(home: string, say: (s: string) => void = () => {}): string[] {
  const p = serviceConfigPath(home);
  if (!existsSync(p)) return [];
  let d: { schema?: unknown; runArgs?: unknown };
  try { d = JSON.parse(readFileSync(p, 'utf8')) as typeof d; } catch (e) { say(`service.json is not JSON (${errMsg(e)}); ignored`); return []; }
  if (d.schema !== SERVICE_CONFIG_SCHEMA || !Array.isArray(d.runArgs)) { say('service.json: unknown shape; ignored'); return []; }
  const out: string[] = [];
  const a = d.runArgs.filter((x): x is string => typeof x === 'string');
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--stub') out.push('--stub');
    else if (FLEET_PASS.includes(a[i]) && typeof a[i + 1] === 'string') out.push(a[i], a[++i]);
    else { say(`service.json: ${JSON.stringify(a[i])} is not allowed in runArgs; ignored`); }
  }
  return out;
}

/** Recorder health: installed (its OS job exists) and how old the DB's last write is (file times; never opens it). */
function recorderProbe(io: AutotradeIo, userHome: string, now: number): { installed: boolean; newestAgeMs: number | null } {
  const label = 'xyz.dexterm.collector';
  const installed = process.platform === 'darwin' ? existsSync(join(userHome, 'Library', 'LaunchAgents', `${label}.plist`))
    : process.platform === 'linux' ? existsSync(join(userHome, '.config', 'systemd', 'user', 'dexterm-collector.service')) : false;
  const db = io.env.DEXTERM_DB_PATH || defaultDbPath(io.env);
  let newest = 0;
  for (const p of [db, `${db}-wal`]) { try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* absent */ } }
  return { installed, newestAgeMs: newest ? now - newest : null };
}

function busyProbe(patterns: string[]): string[] {
  if (!patterns.length || process.platform === 'win32') return [];
  const hit: string[] = [];
  for (const p of patterns) {
    const r = spawnSync('pgrep', ['-f', p], { encoding: 'utf8', timeout: 3000 });
    const pids = (r.stdout ?? '').split('\n').map(Number).filter((n) => n && n !== process.pid && n !== r.pid);
    if (pids.length) hit.push(p);
  }
  return hit;
}

function freeGbOf(home: string): number | null {
  try { const s = statfsSync(home); return (s.bavail * s.bsize) / 1e9; } catch { return null; }
}

async function runServiceCmd(argv: string[], io: AutotradeIo, deps: ServiceDeps): Promise<number> {
  const { opts } = parseArgs(argv, ['stub', 'quiet']);
  const home = homeOf(io);
  const clock = deps.now ?? Date.now;
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  const stop0 = readStopMarker(home);
  if (stop0) { io.stderr.write(`dexterm autotrade service run: the service is stopped (${stop0.reason}); \`dexterm autotrade service start\` lifts it\n`); return 1; }
  const lock = acquireServiceLock(home);
  if (!lock.ok) { io.stderr.write(`dexterm autotrade service run: the service is already running (pid ${lock.holder.pid}); it never runs twice\n`); return 1; }
  try { setPriority(10); } catch { /* best effort (launchd / systemd already set Nice 10) */ }
  const log = new BoundedLog(serviceLogPath(home));
  const notify = notifier(home, deps, log);
  // In a terminal the lines show as they are logged; detached (stdout = service.out) the log alone has them.
  const echo = !opts.quiet && !!(process.stdout as { isTTY?: boolean }).isTTY && !deps.fleet;
  const say = (s: string) => { log.line(s); if (echo) io.stdout.write(`${s}\n`); };
  const startedAt = clock();
  if (lock.reclaimed) say(`reclaimed a stale service lock (pid ${lock.reclaimed.pid} is gone)`);

  // Crash recovery: the fleet the last run hosted, when it did not end cleanly.
  const prevHb = readServiceHeartbeat(home);
  const prev = readServiceState(home);
  const adopt = new Map<string, Position[]>();
  const taken = new Map<string, Set<string>>();
  let resumed: ServiceHeartbeat['resumed'] = null;
  let fromFleet: string | null = null;
  if (prev?.fleetId && (lastRunCrashed(prevHb) || !prevHb)) {
    const rec = recoverFleet(home, prev.fleetId);
    if (rec.crashed) {
      fromFleet = prev.fleetId;
      let n = 0, coins = 0;
      for (const m of rec.members) {
        if (m.positions.length) adopt.set(m.member, m.positions);
        taken.set(m.member, new Set(m.taken));
        n += m.positions.length; coins += m.taken.length;
        for (const p of m.problems) say(`recovery [${m.member}]: ${p}`);
      }
      for (const p of rec.problems) say(`recovery: ${p}`);
      resumed = { positions: n, takenCoins: coins };
      say(`recovery: fleet ${prev.fleetId} ended without a clean stop; ${n} open paper position${n === 1 ? '' : 's'} carried over, ${coins} coin${coins === 1 ? '' : 's'} it took will not be bought again`);
    }
  }

  const rc = loadRunnerConfig(home);
  const guard = new ServiceGuard(guardConfigFrom(rc.ok ? rc.config : null));
  const ks = deps.killSwitch ?? new KillSwitch();
  const userHome = deps.userHome ?? io.env.HOME ?? io.env.USERPROFILE ?? homedir();

  let state: ServiceRunState = 'starting';
  let fleetId: string | null = null;
  let lastFleet: FleetStatus | null = null;
  let lastAdvance = clock();
  let lastT = 0;
  let guardStopSent = false;
  let lastGuard: ReturnType<ServiceGuard['evaluate']> | null = null;
  let recorderCache: { at: number; v: GuardInputs['recorder'] } = { at: 0, v: null };
  let busyCache: { at: number; v: string[] } = { at: 0, v: [] };

  const beat = () => {
    const now = clock();
    const hb: ServiceHeartbeat = { schema: SERVICE_SCHEMA, pid: process.pid, startedAt, heartbeatAt: now, state, fleetId, guard: lastGuard?.states ?? [], resumed, dataAgeMs: lastT ? now - lastAdvance : null };
    try { writeServiceHeartbeat(home, hb); } catch (e) { log.line(`heartbeat failed: ${errMsg(e)}`); }
  };

  const evaluate = () => {
    const now = clock();
    const cfg = guard.cfg;
    if (deps.probe?.recorder !== undefined) recorderCache = { at: now, v: deps.probe.recorder };
    else if (now - recorderCache.at >= 60_000) recorderCache = { at: now, v: recorderProbe(io, userHome, now) };
    if (deps.probe?.busy !== undefined) busyCache = { at: now, v: deps.probe.busy };
    else if (now - busyCache.at >= 30_000) busyCache = { at: now, v: busyProbe(cfg.busyProcs) };
    const stop = readStopMarker(home);
    const panic = ks.engaged();
    let runnerAge: number | null = null;
    try { const r = JSON.parse(readFileSync(runnerRendezvousPath(home), 'utf8')) as { runId?: string; heartbeatAt?: number }; if (fleetId && r.runId === fleetId && typeof r.heartbeatAt === 'number') runnerAge = now - r.heartbeatAt; } catch { /* not yet */ }
    const halted: Record<string, string> = {};
    for (const m of lastFleet?.members ?? []) if (m.state === 'halted' && m.haltReason && !['stop', 'flatten', 'kill-switch', 'runner-stopped'].includes(m.haltReason)) halted[m.id] = m.haltReason;
    const v = guard.evaluate({
      now, stopFile: stop ? stop.reason : null, panic: panic ? panic.reason : null,
      freeGb: deps.probe?.freeGb !== undefined ? deps.probe.freeGb : freeGbOf(home),
      load1m: deps.probe?.load1m !== undefined ? deps.probe.load1m : (process.platform === 'win32' ? null : loadavg()[0]),
      busy: busyCache.v, dataAgeMs: lastT ? now - lastAdvance : null, upMs: fleetId ? now - startedAt : 0, runnerAgeMs: runnerAge,
      allowance: lastFleet?.global.allowance ?? null, dayCap: lastFleet?.global.blocked ?? null, recorder: recorderCache.v, halted,
    });
    lastGuard = v;
    for (const t of v.transitions) {
      say(`guard ${t.on ? 'ON ' : 'off'} ${t.id}: ${t.detail}`);
      fleetLedger?.add(now, 'service_guard', { id: t.id, on: t.on, effect: t.effect, detail: t.detail.slice(0, 200) });
      if (t.on || t.effect !== 'notice') void notify(guardNoticeText(t));
    }
    if (v.stop && fleetId && !guardStopSent) {
      guardStopSent = true;
      const w = requestControl(home, fleetId, 'stop', 'cli');
      say(`guard ${v.stop}: stopping every strategy (no new entries; exits keep running until nothing is held)${w.ok ? '' : ` (${w.why})`}`);
    }
    beat();
  };

  let fleetLedger: { add(t: number, kind: string, data?: Record<string, unknown>): unknown } | null = null;
  const tickMs = deps.beatMs ?? SERVICE_HEARTBEAT_MS;
  const timer = setInterval(evaluate, tickMs);
  // The STOP file is checked every second (a `touch` stops the strategies within a step).
  const stopWatch = setInterval(() => { if (!guardStopSent && fleetId && existsSync(serviceStopPath(home))) evaluate(); }, Math.min(1000, tickMs));
  beat();

  // The user's own bot: notifications for every strategy's events and /status /pause /stop through the control file.
  let tg: TelegramService | null = null;
  try { tg = await startTelegram(home, () => fleetId, say); } catch (e) { say(`telegram: not started (${errMsg(e)})`); }

  const takenVet = (m: FleetMemberSpec, inner: VetFn | undefined): VetFn | undefined => {
    const set = taken.get(m.config.id);
    if (!set?.size) return inner;
    return async (k) => (set.has(k.mint) ? { ok: false, rule: RESUME_TAKEN_RULE, detail: 'a run that crashed already took this coin' } : inner ? inner(k) : { ok: true });
  };

  // Flags: this command line first, then service.json `runArgs` (what a scheduler-started run uses).
  const cfgArgs = readServiceConfig(home, say);
  const cfg = parseArgs(cfgArgs, ['stub']).opts;
  const fleetArgv = ['--all', '--paper', ...(opts.stub || cfg.stub ? ['--stub'] : [])];
  for (const f of FLEET_PASS) { const v = opts[f.slice(2)] ?? cfg[f.slice(2)]; if (typeof v === 'string') fleetArgv.push(f, v); }
  const over: FleetRunOverrides = {
    ...deps.fleetOver,
    extraSafety: () => ({ pauseEntries: lastGuard?.pauseEntries ?? null }),
    vetWrap: takenVet,
    adopt: (id) => adopt.get(id),
    onStarted: (id, fl) => {
      fleetId = id; fleetLedger = fl; state = 'running';
      writeServiceState(home, { fleetId: id, startedAt, pid: process.pid });
      fl.add(clock(), 'service_start', { pid: process.pid, fromFleet, resumed });
      if (taken.size) fl.add(clock(), 'service_resume', { fromFleet, members: Object.fromEntries([...taken].map(([k, v]) => [k, { taken: [...v], adopted: adopt.get(k)?.length ?? 0 }])) });
      say(`fleet ${id} started`);
      beat();
      deps.fleetOver?.onStarted?.(id, fl);
    },
    hooks: strategyTaggedHooks({ onEvent: (e) => tg?.onLedger(e) }, {
      onMemberState: (m, r, st) => {
        if (st.t > lastT) { lastT = st.t; lastAdvance = clock(); }
        deps.fleetOver?.hooks?.onMemberState?.(m, r, st);
      },
      onMemberEvent: (m, r, e) => deps.fleetOver?.hooks?.onMemberEvent?.(m, r, e),
      onFleetState: (st) => {
        lastFleet = st;
        if (tg) { try { const rs = JSON.parse(readFileSync(runnerRendezvousPath(home), 'utf8')) as RunnerState; tg.onState(rs); } catch { /* not yet */ } }
        deps.fleetOver?.hooks?.onFleetState?.(st);
      },
    }),
  };
  const fleetIo: AutotradeIo = { ...io, stdout: log.writer(), stderr: log.writer('! ') };
  say(`service started (pid ${process.pid}, home ${home === defaultHomeOf(io) ? 'default' : 'custom'})`);
  let code = 1;
  let crashed = false;
  try {
    code = await (deps.fleet ?? fleetRunCmd)(fleetArgv, fleetIo, over);
  } catch (e) {
    crashed = true;
    say(`the strategies failed: ${errMsg(e)}`);
  }
  clearInterval(timer);
  clearInterval(stopWatch);
  const last = lastFleet as FleetStatus | null;
  const halt = last?.haltReason ?? null;
  let endReason: string;
  if (crashed || (fleetId && code !== 0 && !halt)) {
    // An error after the strategies started is a crash: the next tick restarts and recovers.
    state = 'starting';
    endReason = 'failed';
    crashed = true;
  } else if (!fleetId) {
    endReason = 'could not start the strategies (see the service log)';
    writeStopMarker(home, 'fleet', endReason);
    await notify(`autotrade service · CANNOT RUN · ${endReason}: fix it, then \`dexterm autotrade service start\``);
    state = 'stopped';
  } else if (halt === 'runner-stopped') {
    // A signal (logout, shutdown, `kill`) or --max-minutes: a clean end that the next login starts again.
    endReason = 'signal or time limit';
    state = 'stopped';
  } else {
    const stopM = readStopMarker(home);
    endReason = stopM ? stopM.reason : halt ? `the strategies stopped (${halt})` : 'every strategy ended';
    if (!stopM) writeStopMarker(home, 'fleet', endReason);
    state = 'stopped';
    await notify(`autotrade service · STOPPED · ${endReason}; it stays stopped until \`dexterm autotrade service start\``);
  }
  if (state === 'stopped') writeServiceState(home, { fleetId: null, startedAt, pid: process.pid });
  try { writeServiceHeartbeat(home, { schema: SERVICE_SCHEMA, pid: process.pid, startedAt, heartbeatAt: clock(), state: crashed ? 'starting' : 'stopped', fleetId: crashed ? fleetId : null, endReason, guard: (lastGuard as ReturnType<ServiceGuard['evaluate']> | null)?.states ?? [], resumed }); } catch { /* best effort */ }
  say(`service ${crashed ? 'FAILED (the next tick restarts it)' : 'stopped'}: ${endReason}`);
  try { await tg?.stop(); } catch { /* closing */ }
  releaseServiceLock(home);
  return crashed ? 1 : 0;
}

/** The paired bot inside the service: notify + /status /pause /stop for the fleet (approvals have no port here). */
async function startTelegram(home: string, runId: () => string | null, say: (s: string) => void): Promise<TelegramService | null> {
  const r = loadConnectors(home);
  if (!r.ok) { say(`telegram: ${r.error}`); return null; }
  const t = r.config.telegram;
  if (!t.enabled || !t.allow.length) return null;
  const token = t.secretStore ? secretStore(t.secretStore, home).get() : null;
  if (!token) { say('telegram: the bot token is missing from the secret store (dexterm telegram setup)'); return null; }
  const connector = new TelegramConnector({ token: () => token, onLog: (l) => say(`telegram: ${l}`) });
  const refuse = { name: 'service-no-approvals', buy: () => { throw new Error('approvals are not taken by the service'); }, sell: () => { throw new Error('approvals are not taken by the service'); } };
  const port = new PaperPort(refuse as never, { entryBlock: () => 'service-no-approvals' });
  const state = (): RunnerState | null => { try { return JSON.parse(readFileSync(runnerRendezvousPath(home), 'utf8')) as RunnerState; } catch { return null; } };
  const svc = new TelegramService({ home, connector, port, knownToken: () => token, runId, state, strategy: () => null, alert: (l) => say(`! ${l}`) });
  await svc.start();
  say('telegram: your bot is on (notifications, /status, /pause, /stop)');
  return svc;
}

// ───────────────────────────── status / logs ─────────────────────────────

async function statusCmd(argv: string[], io: AutotradeIo, deps: ServiceDeps): Promise<number> {
  const { opts } = parseArgs(argv, ['json', 'clear']);
  const home = homeOf(io);
  const now = (deps.now ?? Date.now)();
  if (opts.clear) { clearAttention(home); io.stdout.write('crash-loop history cleared; the next tick (or `dexterm autotrade service start`) starts the service\n'); }
  const hb = readServiceHeartbeat(home);
  const holder = liveServiceHolder(home);
  const stop = readStopMarker(home);
  const starts = readStarts(home);
  const manifest = readManifest(home);
  const fleet = readFleetStatus(home, now);
  const running = !!holder && !!hb && hb.pid === holder.pid && hb.state !== 'stopped';
  const age = hb ? Math.round((now - hb.heartbeatAt) / 1000) : null;
  const crashes = starts.crashStarts.filter((t) => now - t < 3_600_000).length;
  const doc = {
    running, pid: holder?.pid ?? null, state: hb?.state ?? null, heartbeatAgeSec: age, fleetId: hb?.fleetId ?? null,
    stopped: stop ? { reason: stop.reason, by: stop.by, at: stop.at } : null, attention: starts.attention, crashesLastHour: crashes,
    guard: running ? hb!.guard : [], resumed: hb?.resumed ?? null, dataAgeSec: hb?.dataAgeMs != null ? Math.round(hb.dataAgeMs / 1000) : null,
    installed: manifest ? { platform: manifest.platform, name: manifest.name, loaded: manifest.loaded, files: manifest.files.map((f) => f.path) } : null,
    strategies: fleet.ok && running ? fleet.status.members.map((m) => ({ id: m.id, state: m.state, open: m.open.length, haltReason: m.haltReason })) : [],
    log: serviceLogPath(home),
  };
  if (opts.json) { io.stdout.write(`${JSON.stringify(doc)}\n`); return 0; }
  const L: string[] = [];
  L.push(`service      ${running ? `RUNNING · pid ${holder!.pid} · heartbeat ${age} s ago${hb!.fleetId ? ` · fleet ${hb!.fleetId}` : ''}` : stop ? `STOPPED (${stop.reason}) · \`dexterm autotrade service start\`` : starts.attention ? 'DOWN: crash loop (see below)' : hb && hb.state !== 'stopped' && !holder ? 'DOWN: the last run crashed; the next tick restarts it' : 'not running'}`);
  L.push(`installed    ${manifest ? `${manifest.name} (${manifest.platform}${manifest.loaded ? ', loaded' : ', written, not loaded'})` : 'no (`dexterm autotrade service install`)'}`);
  if (starts.attention) L.push(`ATTENTION    ${starts.attention.why}\n             look at \`dexterm autotrade service logs\`, then \`dexterm autotrade service status --clear\``);
  else if (crashes) L.push(`crashes      ${crashes} in the last hour (gives up after 5)`);
  if (running && hb!.resumed) L.push(`resumed      ${hb!.resumed.positions} open position(s) carried over from a crash; ${hb!.resumed.takenCoins} coin(s) never bought again`);
  if (running && hb!.dataAgeMs != null) L.push(`market data  newest tick ${Math.round(hb!.dataAgeMs / 1000)} s ago`);
  if (running) {
    L.push(`guard        ${hb!.guard.length ? '' : 'all clear'}`);
    for (const g of hb!.guard) L.push(`  ${g.effect === 'stop' ? 'STOP ' : g.effect === 'pause-entries' ? 'PAUSE' : 'note '} ${g.id}: ${g.detail}`);
    for (const s of doc.strategies) L.push(`  strategy ${s.id}: ${s.state}${s.haltReason ? ` (${s.haltReason})` : ''} · ${s.open} open`);
  }
  L.push(`log          ${serviceLogPath(home)}`);
  io.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

function logsCmd(argv: string[], io: AutotradeIo): number {
  const n = (() => { const i = argv.indexOf('-n'); const v = i >= 0 ? Number(argv[i + 1]) : 50; return Number.isFinite(v) && v > 0 ? Math.min(v, 2000) : 50; })();
  const home = homeOf(io);
  const lines = tailServiceLog(home, n);
  io.stdout.write(lines.length ? `${lines.join('\n')}\n` : `no service log yet (${serviceLogPath(home)})\n`);
  return 0;
}

// ───────────────────────────── install / uninstall ─────────────────────────────

function readManifest(home: string): InstallManifest | null {
  try { const d = JSON.parse(readFileSync(installManifestPath(home), 'utf8')) as InstallManifest; return d.schema === INSTALL_MANIFEST_SCHEMA ? d : null; } catch { return null; }
}

export function installSpec(io: AutotradeIo, platform: ServicePlatform, userHome: string): InstallSpec {
  const home = homeOf(io);
  const dflt = defaultHomeOf(io);
  const bin = sourceBin();
  return {
    platform, label: serviceLabel(home, dflt), nodePath: process.execPath, binPath: bin, workingDir: resolve(dirname(bin), '..', '..', '..'), userHome,
    dexHome: home === dflt ? null : home, tickLog: join(serviceLogDir(home), 'tick.log'), path: platform === 'win32' ? null : (io.env.PATH ?? null), uid: process.getuid?.() ?? 0,
  };
}

/** Parse checks of a plan's files: XML well-formedness (plist, task), systemd sections, and `plutil -lint` on macOS. */
export function verifyPlan(plan: InstallPlan, exec?: ServiceDeps['exec']): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  for (const f of plan.files) {
    const isXml = f.path.endsWith('.plist') || f.path.endsWith('.xml');
    const why = isXml ? xmlProblem(f.content) : iniProblem(f.content);
    if (why) { ok = false; lines.push(`✗ ${f.path}: ${why}`); continue; }
    if (f.path.endsWith('.plist') && /<key>KeepAlive<\/key>/.test(f.content)) { ok = false; lines.push(`✗ ${f.path}: KeepAlive is not allowed`); continue; }
    if (f.path.endsWith('.plist') && process.platform === 'darwin') {
      const tmp = join(tmpdir(), `dexterm-service-lint-${process.pid}.plist`);
      writeFileSync(tmp, f.content);
      const r = (exec ?? defaultExec)(['plutil', '-lint', tmp]);
      rmSync(tmp, { force: true });
      if (r.status !== 0) { ok = false; lines.push(`✗ ${f.path}: plutil -lint: ${r.out.trim()}`); continue; }
      lines.push(`✓ ${f.path}: parses (plutil -lint OK), StartInterval 60, no KeepAlive`);
    } else lines.push(`✓ ${f.path}: parses`);
  }
  return { ok, lines };
}

/** A small well-formedness check: every tag closes in order (comments, declarations and self-closing tags skipped). */
export function xmlProblem(s: string): string | null {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (!m[2]) continue;
    if (m[4] === '/') continue;
    if (m[1]) { const top = stack.pop(); if (top !== m[2]) return `</${m[2]}> closes <${top ?? 'nothing'}>`; }
    else stack.push(m[2]);
  }
  if (stack.length) return `<${stack[stack.length - 1]}> is never closed`;
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(s.replace(/<!--[\s\S]*?-->/g, ''))) return 'a bare & (not escaped)';
  return null;
}

/** systemd unit files: [Section] headers and Key=Value lines only. */
export function iniProblem(s: string): string | null {
  let section = false;
  for (const [i, raw] of s.split('\n').entries()) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith(';')) continue;
    if (/^\[[A-Za-z]+\]$/.test(l)) { section = true; continue; }
    if (!section) return `line ${i + 1}: a key before any [Section]`;
    if (!/^[A-Za-z][A-Za-z0-9]*=/.test(l)) return `line ${i + 1}: not Key=Value`;
  }
  return section ? null : 'no [Section]';
}

const defaultExec = (cmd: string[]): { status: number | null; out: string } => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
};

async function installCmd(argv: string[], io: AutotradeIo, deps: ServiceDeps): Promise<number> {
  const { opts } = parseArgs(argv, ['dry-run', 'load', 'json']);
  const home = homeOf(io);
  const platform = (typeof opts.platform === 'string' ? opts.platform : deps.platform ?? process.platform) as ServicePlatform;
  if (!['darwin', 'linux', 'win32'].includes(platform)) { io.stderr.write(`dexterm autotrade service install: no installer for ${platform} (darwin, linux, win32)\n`); return 2; }
  const userHome = deps.userHome ?? io.env.HOME ?? io.env.USERPROFILE ?? homedir();
  const spec = installSpec(io, platform, userHome);
  const plan = installPlan(spec, home);
  const dry = !!opts['dry-run'];
  const out = (s: string) => io.stdout.write(`${s}\n`);
  out(`dexterm autotrade service install${dry ? ' --dry-run (nothing is written)' : ''}: ${platform}, ${plan.name}`);
  out(`It runs \`dexterm autotrade service ensure${spec.dexHome ? ` --home ${spec.dexHome}` : ''}\` every minute and at login. Exactly these files:`);
  for (const f of plan.files) { out(`\n── ${f.path}${f.encoding === 'utf16le' ? ' (UTF-16 LE, as Task Scheduler wants)' : ''}`); io.stdout.write(f.content); }
  const v = verifyPlan(plan, platform === process.platform ? deps.exec : () => ({ status: 0, out: '' }));
  out('\nchecks:');
  for (const l of v.lines) out(`  ${l}`);
  if (!v.ok) { io.stderr.write('dexterm autotrade service install: a generated file did not pass its check; nothing written\n'); return 1; }
  out(`\nto load it: ${plan.activate.map((c) => c.join(' ')).join(' && ')}`);
  for (const n of plan.notes) out(`note: ${n}`);
  if (dry) return 0;
  if (platform !== process.platform && !deps.platform) { io.stderr.write(`dexterm autotrade service install: this machine is ${process.platform}; --platform ${platform} only works with --dry-run\n`); return 2; }
  const prev = readManifest(home);
  for (const f of plan.files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, encode(f.content, f.encoding));
  }
  mkdirSync(serviceLogDir(home), { recursive: true, mode: 0o700 });
  const manifest: InstallManifest = { schema: INSTALL_MANIFEST_SCHEMA, platform, label: plan.label, name: plan.name, installedAt: (deps.now ?? Date.now)(), files: plan.files.map((f) => ({ path: f.path, sha256: fileSha(f.content, f.encoding) })), deactivate: plan.deactivate, loaded: false };
  // Files a previous install wrote that this one did not (a renamed label) are removed, so uninstall stays exact.
  for (const f of prev?.files ?? []) if (!plan.files.some((x) => x.path === f.path)) rmSync(f.path, { force: true });
  mkdirSync(dirname(installManifestPath(home)), { recursive: true, mode: 0o700 });
  writeFileSync(installManifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  out(`\nwrote ${plan.files.map((f) => f.path).join(', ')} (recorded in ${installManifestPath(home)})`);
  if (!opts.load) { out('NOT loaded: run the command above, or `dexterm autotrade service install --load`, once you have read it.'); return 0; }
  const ex = deps.exec ?? defaultExec;
  for (const [i, c] of plan.activate.entries()) {
    const r = ex(c);
    // The first macOS step (bootout) fails when nothing is loaded yet: that is fine.
    if (r.status !== 0 && !(platform === 'darwin' && i === 0)) { io.stderr.write(`dexterm autotrade service install: ${c.join(' ')} exited ${r.status}: ${r.out.trim().slice(0, 300)}\n`); return 1; }
  }
  manifest.loaded = true;
  writeFileSync(installManifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  out('✓ loaded: the service starts within a minute (`dexterm autotrade service status`)');
  return 0;
}

async function uninstallCmd(argv: string[], io: AutotradeIo, deps: ServiceDeps): Promise<number> {
  const { opts } = parseArgs(argv, ['flatten', 'yes', 'force', 'dry-run', 'json']);
  const home = homeOf(io);
  const m = readManifest(home);
  const out = (s: string) => io.stdout.write(`${s}\n`);
  if (!m) { out(`nothing installed for this home (no ${installManifestPath(home)})`); return 0; }
  const r = activeRunner(home);
  if (r && r.positions > 0 && !opts.flatten) {
    io.stderr.write(`dexterm autotrade service uninstall: ${r.positions} position${r.positions === 1 ? ' is' : 's are'} open. Stop first and let the exits close them (\`dexterm autotrade service stop\`), or sell them now with --flatten --yes\n`);
    return 1;
  }
  if (opts.flatten && !opts.yes) { io.stderr.write('dexterm autotrade service uninstall --flatten sells every open paper position: add --yes to confirm\n'); return 2; }
  if (opts['dry-run']) {
    out(`would stop the service, run ${m.deactivate.map((c) => c.join(' ')).join(' && ')}, and remove:`);
    for (const f of m.files) out(`  ${f.path}`);
    return 0;
  }
  const s = await stopService(io, opts.flatten ? 'flatten' : 'stop', 'uninstall', waitOf(opts.wait));
  for (const l of s.lines) out(l);
  const ex = deps.exec ?? defaultExec;
  if (m.loaded || m.platform === 'darwin') for (const c of m.deactivate) { const x = ex(c); out(`${c.join(' ')}: ${x.status === 0 ? 'ok' : `exit ${x.status} (${x.out.trim().slice(0, 120) || 'not loaded'})`}`); }
  let kept = 0;
  for (const f of m.files) {
    if (!existsSync(f.path)) { out(`already gone: ${f.path}`); continue; }
    const cur = readFileSync(f.path);
    const sha = (await import('node:crypto')).createHash('sha256').update(cur).digest('hex');
    if (sha !== f.sha256 && !opts.force) { kept++; io.stderr.write(`kept ${f.path}: it changed since install (remove it yourself, or --force)\n`); continue; }
    rmSync(f.path, { force: true });
    out(`removed ${f.path}`);
  }
  if (kept) return 1;
  rmSync(installManifestPath(home), { force: true });
  out('✓ uninstalled: the OS job is gone; the service stays stopped');
  return 0;
}

export type { EnsureDecision };
