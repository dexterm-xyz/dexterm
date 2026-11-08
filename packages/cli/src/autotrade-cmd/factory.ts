// `dexterm autotrade factory …` and `dexterm autotrade generate` (task-2159): the strategy factory. PAPER ONLY.
//
//   run [--stub] [--max-candidates N] [--focus TEXT] [--db PATH] [--no-forward] [--json]   one generation run now (caps apply)
//   status [--json]                          last run, candidates and their stage, spend today, caps, the schedule
//   show <id>                                a generated strategy's rationale + held-out result
//   retire <id> [--why TEXT]                 retire a generated strategy (kept on disk)
//   stop [--why TEXT] | resume               write / remove FACTORY-STOP (resume also lifts an agent's AGENT-PAUSE)
//   pending                                  changes MCP agents proposed, waiting for you (task-2167)
//   confirm <code> [--cancel]                apply (or cancel) one agent proposal: your terminal is the confirm
//   unretire <id>                            undo a retire: queued for a paper forward test again
//   run --inbox-only                         admit the candidates agents offered (no analyst call, no spend)
//   config [show | set KEY VALUE … | reset]  factory.json (validated; ceilings refused)
//   lessons                                  what the factory has learned so far
//   install [--dry-run] [--load] [--platform P] | uninstall [--dry-run]   the schedule (a generated LaunchAgent / systemd timer)
// `--home PATH` = DEXTERM_HOME for that call (the schedule passes it for a non-default home).
// `generate` = `factory run`. `--scheduled` (the schedule's runs) skips when the last run is newer than the interval.
//
// The analyst is the user's own `claude -p` (no tools, a hard per-call budget); `--stub` uses a stub (no Claude, no
// spend). Candidates are paper strategies; nothing is promoted, published or armed.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { dextermHome } from '@dexterm/custom';
import { defaultDbPath } from '@dexterm/data';
import { openHistoryReadOnly } from '@dexterm/recorder';
import {
  agentPaused, clearAgentPause, claudeAnalyst, clearFactoryStop, confirmAgentChange, describeFactorySchedule, encode, listPending, StrategyStore, unretireGenerated, AGENT_CHAT_ID, factoryDir, factoryInstallPlan, factoryLabel, factoryManifestPath, factoryStatus,
  factoryStopped, generatedPath, loadFactoryConfig, loadGenerated, manifestFor, readLessons, renderFactoryStatus, retireGenerated, runFactory, saveFactoryConfig, stubAnalyst,
  tapeFromDb, tapeFromDoc, writeFactoryStop, loadTape,
  type FactoryAnalyst, type FactoryConfig, type FactoryInstallManifest, type FactoryInstallSpec, type ForwardTest, type InstallPlan, type ServicePlatform, type Tape,
} from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';
import { sourceBin, verifyPlan } from './service.ts';
import { spawnForwardHost } from './forward.ts';

export const FACTORY_USAGE = 'dexterm autotrade factory run|status|show|retire|unretire|stop|resume|pending|confirm|config|lessons|install|uninstall [--home PATH]';

export interface FactoryCmdDeps {
  now?: () => number;
  analyst?: FactoryAnalyst;
  tape?: (w: { since: number; until: number }, c: FactoryConfig) => Tape | null;
  forwardSpawner?: ((home: string, t: ForwardTest) => number | null) | null;
  exec?: (cmd: string[]) => { status: number | null; out: string };
  platform?: ServicePlatform;
  userHome?: string;
}

const errOut = (io: AutotradeIo, s: string): void => { io.stderr.write(`dexterm autotrade factory: ${s}\n`); };
const defaultExec = (cmd: string[]): { status: number | null; out: string } => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
};

/** The recorder tape for a window, read-only (the live DB file is opened read-only, never written or copied). */
export function recorderTape(io: AutotradeIo, dbPath?: string) {
  return (w: { since: number; until: number }, c: FactoryConfig): Tape | null => {
    const path = dbPath ?? (io.env.DEXTERM_DB_PATH || defaultDbPath(io.env));
    if (!existsSync(path)) return null;
    let db: ReturnType<typeof openHistoryReadOnly>;
    try { db = openHistoryReadOnly(path); } catch { return null; }
    if (!db) return null;
    try { return tapeFromDoc(tapeFromDb(db, { since: w.since, until: w.until, minPeakLiqUsd: c.tape.minPeakLiqUsd, spanHours: c.tape.spanHours, minLiveRows: c.tape.minLiveRows, maxMints: c.tape.maxMints })); } finally { db.close(); }
  };
}

/** Start the factory run detached (the chat's "run the factory now"); its output goes to the factory log. */
export function spawnFactoryRun(home: string, env: NodeJS.ProcessEnv, by = 'chat'): number | null {
  mkdirSync(factoryDir(home), { recursive: true, mode: 0o700 });
  const fd = openSync(join(factoryDir(home), 'factory.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [sourceBin(), 'autotrade', 'factory', 'run', '--by', by, '--quiet'], { detached: true, stdio: ['ignore', fd, fd], env: { ...env, DEXTERM_HOME: home }, windowsHide: true });
    child.unref();
    return child.pid ?? null;
  } finally { closeSync(fd); }
}

export async function factoryCmd(argv: string[], io0: AutotradeIo, deps: FactoryCmdDeps = {}): Promise<number> {
  const [sub, ...rest0] = argv;
  const rest: string[] = [];
  let io = io0;
  for (let i = 0; i < rest0.length; i++) {
    if (rest0[i] === '--home') {
      const h = rest0[++i];
      if (!h) { errOut(io0, '--home needs a PATH'); return 2; }
      io = { ...io0, env: { ...io0.env, DEXTERM_HOME: resolve(h) } };
    } else rest.push(rest0[i]);
  }
  switch (sub) {
    case 'run': return runCmd(rest, io, deps);
    case 'status': return statusCmd(rest, io, deps);
    case 'show': return showCmd(rest, io);
    case 'retire': return retireCmd(rest, io, deps);
    case 'stop': { const { opts } = parseArgs(rest); const s = writeFactoryStop(dextermHome(io.env), 'cli', typeof opts.why === 'string' ? opts.why : 'stopped from the CLI', (deps.now ?? Date.now)()); io.stdout.write(`FACTORY-STOP written (${s.at}): no factory run starts until \`dexterm autotrade factory resume\`. Forward tests and strategies are not touched.\n`); return 0; }
    case 'resume': { const h = dextermHome(io.env); const s = clearFactoryStop(h); const a = clearAgentPause(h); io.stdout.write(s || a ? `${[s ? 'FACTORY-STOP' : '', a ? 'AGENT-PAUSE' : ''].filter(Boolean).join(' and ')} removed: the next scheduled run goes ahead within its caps.\n` : 'the factory was not stopped\n'); return 0; }
    case 'unretire': return unretireCmd(rest, io, deps);
    case 'pending': return pendingCmd(io, deps);
    case 'confirm': return confirmCmd(rest, io, deps);
    case 'config': return configCmd(rest, io);
    case 'lessons': io.stdout.write(readLessons(dextermHome(io.env)).trimEnd() + '\n'); return 0;
    case 'install': return installCmd(rest, io, deps);
    case 'uninstall': return uninstallCmd(rest, io, deps);
    default: io.stdout.write(`${FACTORY_USAGE}\n`); return sub ? 2 : 0;
  }
}

/** `dexterm autotrade generate` = `factory run`. */
export const generateCmd = (argv: string[], io: AutotradeIo): Promise<number> => factoryCmd(['run', ...argv], io);

async function runCmd(argv: string[], io: AutotradeIo, deps: FactoryCmdDeps): Promise<number> {
  const { opts } = parseArgs(argv, ['stub', 'scheduled', 'quiet', 'json', 'no-forward', 'inbox-only']);
  const home = dextermHome(io.env);
  const quiet = !!opts.quiet;
  const say = (s: string) => { if (!quiet && !opts.json) io.stdout.write(`${s}\n`); };
  const stamp = (s: string) => io.stdout.write(`${new Date().toISOString()} ${s}\n`);
  const maxC = typeof opts['max-candidates'] === 'string' ? Number(opts['max-candidates']) : undefined;
  const focus = typeof opts.focus === 'string' ? opts.focus : undefined;
  if (opts.focus !== undefined && !focus?.trim()) { errOut(io, '--focus needs a few words: what this run should try'); return 2; }
  if (maxC !== undefined && !(Number.isInteger(maxC) && maxC >= 1)) { errOut(io, '--max-candidates must be a whole number >= 1'); return 2; }
  let tape = deps.tape ?? recorderTape(io, typeof opts.db === 'string' ? opts.db : undefined);
  if (typeof opts.tape === 'string') { const f = loadTape(opts.tape); tape = () => f; } // tests / a demo on a saved tape: both windows use it
  const analyst = deps.analyst ?? (opts.stub ? stubAnalyst() : claudeAnalyst({ env: io.env }));
  const spawner = opts['no-forward'] ? null : deps.forwardSpawner !== undefined ? deps.forwardSpawner : (h: string, t: ForwardTest) => spawnForwardHost(h, t, io.env);
  say(`dexterm strategy factory (PAPER; candidates are not edges)${opts.stub ? ' · stub analyst, no Claude spend' : ''}`);
  const r = await runFactory({
    home, analyst, tape, now: deps.now, forwardSpawner: spawner, by: typeof opts.by === 'string' && /^[a-z][a-z0-9-]{0,15}$/.test(opts.by) ? opts.by : opts.scheduled ? 'schedule' : 'cli',
    scheduled: !!opts.scheduled, maxCandidates: maxC, inboxOnly: !!opts['inbox-only'], focus, log: quiet ? (l) => { if (/^factory fr_|^rejected|^candidate/.test(l)) stamp(l); } : opts.json ? undefined : (l) => say(`  ${l}`),
  });
  if (opts.json) { io.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.ok ? 0 : 1; }
  if (quiet) { if (r.stop && r.stop !== 'not-due') stamp(`factory: ${r.verdict}`); return r.ok ? 0 : 1; }
  say('');
  say(r.verdict);
  for (const g of r.candidates) {
    say(`\n${g.id}  ${g.name}  [${g.label}]`);
    say(`  parents: ${g.parents.join(', ')} · stage: ${g.stage}`);
    say(`  why: ${g.rationale.summary}`);
    if (g.heldOut) say(`  held out (${g.heldOut.window.from} → ${g.heldOut.window.to}, ${g.heldOut.mints} coins): n ${g.heldOut.n}, mean ${g.heldOut.meanPct}% (95% ${g.heldOut.lo} to ${g.heldOut.hi}), 2x costs ${g.heldOut.mean2xPct}%, without top 3 ${g.heldOut.noTop3Pct}%, rug ${g.heldOut.rugRatePct}%`);
    if (g.heldOut) say(`  verdict: ${g.heldOut.verdict}`);
    say(`  report: ${join(generatedPath(home, g.id), 'report.json')}`);
  }
  for (const x of r.rejects) say(`rejected (attempt ${x.attempt}): ${x.reasons.slice(0, 3).join('; ')}`);
  say(`spend: ${r.calls} call(s), $${Math.round(r.spendUsd * 10000) / 10000} · ${Math.round(r.ms / 100) / 10} s`);
  return r.ok ? 0 : 1;
}

function statusCmd(argv: string[], io: AutotradeIo, deps: FactoryCmdDeps): number {
  const { opts } = parseArgs(argv, ['json']);
  const home = dextermHome(io.env);
  const v = factoryStatus(home, (deps.now ?? Date.now)());
  const m = readManifest(home);
  if (opts.json) { io.stdout.write(`${JSON.stringify({ ...v, schedule: m ? { label: m.label, loaded: m.loaded, at: m.at, intervalHours: m.intervalHours } : null }, null, 2)}\n`); return 0; }
  for (const l of renderFactoryStatus(v)) io.stdout.write(`${l}\n`);
  io.stdout.write(`schedule: ${m ? `${m.name} (${m.loaded ? 'loaded' : 'written, not loaded'}; ${describeFactorySchedule(m.at, m.intervalHours)})` : 'not installed (`dexterm autotrade factory install`)'}\n`);
  return 0;
}

function showCmd(argv: string[], io: AutotradeIo): number {
  const id = argv[0];
  const home = dextermHome(io.env);
  const g = id ? loadGenerated(home, id) : null;
  if (!g) { errOut(io, `no generated strategy ${id ?? ''} (factory status lists them)`); return 2; }
  const p = join(generatedPath(home, g.id), 'rationale.md');
  io.stdout.write(existsSync(p) ? readFileSync(p, 'utf8') : `${JSON.stringify(g, null, 2)}\n`);
  return 0;
}

function retireCmd(argv: string[], io: AutotradeIo, deps: FactoryCmdDeps): number {
  const { pos, opts } = parseArgs(argv);
  if (!pos[0]) { errOut(io, 'usage: dexterm autotrade factory retire <id> [--why TEXT]'); return 2; }
  const r = retireGenerated(dextermHome(io.env), pos[0], 'cli', typeof opts.why === 'string' ? opts.why : 'retired by the user (CLI)', (deps.now ?? Date.now)());
  if (!r.ok) { errOut(io, r.why); return 2; }
  io.stdout.write(r.already ? `${pos[0]} was already retired\n` : `${pos[0]} retired (kept on disk with its report)\n`);
  return 0;
}

function unretireCmd(argv: string[], io: AutotradeIo, deps: FactoryCmdDeps): number {
  const { pos } = parseArgs(argv);
  if (!pos[0]) { errOut(io, 'usage: dexterm autotrade factory unretire <id>'); return 2; }
  const r = unretireGenerated(dextermHome(io.env), pos[0], 'cli', (deps.now ?? Date.now)());
  if (!r.ok) { errOut(io, r.why); return 2; }
  io.stdout.write(`${pos[0]} is ${r.report.stage} again (paper; its always-on entry, if it had one, stays off)\n`);
  return 0;
}

/** task-2167: what MCP agents proposed and wait for the user (on/off of an always-on strategy, resume past FACTORY-STOP). */
function pendingCmd(io: AutotradeIo, deps: FactoryCmdDeps): number {
  const home = dextermHome(io.env);
  const now = (deps.now ?? Date.now)();
  const rows = listPending(home, AGENT_CHAT_ID).filter((p) => p.status === 'pending' && now - p.createdAt <= 24 * 3600e3);
  const ap = agentPaused(home);
  if (ap) io.stdout.write(`the factory is paused by an agent (AGENT-PAUSE, ${ap.by}); \`factory resume\` lifts it\n`);
  if (!rows.length) { io.stdout.write('no agent proposals wait for you\n'); return 0; }
  for (const p of rows) io.stdout.write(`${p.code}  ${p.action}${p.target ? ` ${p.target}` : ''}  from ${p.origin ?? 'an agent'}  ${new Date(p.createdAt).toISOString()}\n  ${p.preview}\n`);
  io.stdout.write('apply one: dexterm autotrade factory confirm <code>   (or --cancel)\n');
  return 0;
}

function confirmCmd(argv: string[], io: AutotradeIo, deps: FactoryCmdDeps): number {
  const { pos, opts } = parseArgs(argv, ['cancel']);
  if (!pos[0]) { errOut(io, 'usage: dexterm autotrade factory confirm <code> [--cancel]'); return 2; }
  const home = dextermHome(io.env);
  const r = confirmAgentChange(home, new StrategyStore({ home }), pos[0].toUpperCase(), { cancel: !!opts.cancel, now: (deps.now ?? Date.now)(), deps: { runFactory: () => !!spawnFactoryRun(home, io.env, 'cli') } });
  if (!r.ok) { (opts.cancel && r.change?.status === 'cancelled' ? io.stdout : io.stderr).write(`${r.why}\n`); return opts.cancel && r.change?.status === 'cancelled' ? 0 : 2; }
  io.stdout.write(`${r.result}\n`);
  return 0;
}

function configCmd(argv: string[], io: AutotradeIo): number {
  const home = dextermHome(io.env);
  const [op = 'show', ...kv] = argv;
  const cur = loadFactoryConfig(home);
  if (op === 'show') {
    if (!cur.ok) { errOut(io, `${cur.path}: ${cur.errors.join('; ')}`); return 1; }
    io.stdout.write(`${JSON.stringify(cur.config, null, 2)}\n${cur.exists ? '' : '(defaults: no factory.json yet)\n'}`);
    return 0;
  }
  if (op === 'reset') { rmSync(join(factoryDir(home), 'factory.json'), { force: true }); io.stdout.write('factory.json removed: the defaults apply\n'); return 0; }
  if (op !== 'set' || kv.length < 2 || kv.length % 2) { errOut(io, 'usage: dexterm autotrade factory config [show | set KEY VALUE [KEY VALUE …] | reset]'); return 2; }
  let doc: Record<string, unknown> = {};
  const path = join(factoryDir(home), 'factory.json');
  if (existsSync(path)) { try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { doc = {}; } }
  for (let i = 0; i < kv.length; i += 2) {
    const [k, raw] = [kv[i], kv[i + 1]];
    const v: unknown = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    const parts = k.split('.');
    if (parts.length === 2 && (parts[0] === 'forward' || parts[0] === 'tape')) doc[parts[0]] = { ...(doc[parts[0]] as object ?? {}), [parts[1]]: v };
    else doc[k] = v;
  }
  const r = saveFactoryConfig(home, doc);
  if (!r.ok) { errOut(io, `refused (nothing written): ${r.errors.join('; ')}`); return 2; }
  io.stdout.write(`saved ${r.path}\n`);
  return 0;
}

// ───────────────────────────── the schedule ─────────────────────────────

function readManifest(home: string): FactoryInstallManifest | null {
  const p = factoryManifestPath(home);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as FactoryInstallManifest; } catch { return null; }
}

export function factorySpec(io: AutotradeIo, platform: ServicePlatform, userHome: string, c: FactoryConfig): FactoryInstallSpec {
  const home = dextermHome(io.env);
  const dflt = dextermHome({ ...io.env, DEXTERM_HOME: '' });
  const bin = sourceBin();
  return {
    platform, label: factoryLabel(home, dflt), nodePath: process.execPath, binPath: bin, workingDir: resolve(dirname(bin), '..', '..', '..'), userHome,
    dexHome: home === dflt ? null : home, log: join(factoryDir(home), 'factory.log'), path: io.env.PATH ?? null, uid: process.getuid?.() ?? 0, at: c.at, intervalHours: c.intervalHours,
  };
}

async function installCmd(argv: string[], io: AutotradeIo, deps: FactoryCmdDeps): Promise<number> {
  const { opts } = parseArgs(argv, ['dry-run', 'load']);
  const home = dextermHome(io.env);
  const cfg = loadFactoryConfig(home);
  if (!cfg.ok) { errOut(io, `${cfg.path} is invalid: ${cfg.errors.join('; ')}`); return 1; }
  const platform = (typeof opts.platform === 'string' ? opts.platform : deps.platform ?? process.platform) as ServicePlatform;
  const userHome = deps.userHome ?? io.env.HOME ?? homedir();
  const spec = factorySpec(io, platform, userHome, cfg.config);
  const got = factoryInstallPlan(spec);
  if (!got.ok) { errOut(io, got.why); return 2; }
  const plan: InstallPlan = got.plan;
  const dry = !!opts['dry-run'];
  const out = (s: string) => io.stdout.write(`${s}\n`);
  out(`dexterm autotrade factory install${dry ? ' --dry-run (nothing is written)' : ''}: ${platform}, ${plan.name}`);
  out(`It runs \`dexterm autotrade factory run --scheduled${spec.dexHome ? ` --home ${spec.dexHome}` : ''}\` ${describeFactorySchedule(spec.at, spec.intervalHours)} (away from the nightly tuner at 02:40). Exactly these files:`);
  for (const f of plan.files) { out(`\n── ${f.path}`); io.stdout.write(f.content); }
  const v = verifyPlan(plan, platform === process.platform ? deps.exec : () => ({ status: 0, out: '' }));
  out('\nchecks:');
  for (const l of v.lines) out(`  ${l.replace(', StartInterval 60, no KeepAlive', ', no KeepAlive')}`);
  if (!v.ok) { errOut(io, 'a generated file did not pass its check; nothing written'); return 1; }
  out(`\nto load it: ${plan.activate.map((c) => c.join(' ')).join(' && ')}`);
  for (const n of plan.notes) out(`note: ${n}`);
  if (dry) return 0;
  if (platform !== process.platform && !deps.platform) { errOut(io, `this machine is ${process.platform}; --platform ${platform} only works with --dry-run`); return 2; }
  const prev = readManifest(home);
  for (const f of plan.files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, encode(f.content, f.encoding)); }
  for (const f of prev?.files ?? []) if (!plan.files.some((x) => x.path === f.path)) rmSync(f.path, { force: true });
  const manifest = manifestFor(plan, spec, false, (deps.now ?? Date.now)());
  mkdirSync(factoryDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(factoryManifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  out(`\nwrote ${plan.files.map((f) => f.path).join(', ')} (recorded in ${factoryManifestPath(home)})`);
  if (!opts.load) { out('NOT loaded: run the command above, or `dexterm autotrade factory install --load`, once you have read it.'); return 0; }
  const ex = deps.exec ?? defaultExec;
  for (const [i, c] of plan.activate.entries()) {
    const r = ex(c);
    if (r.status !== 0 && !(platform === 'darwin' && i === 0)) { errOut(io, `${c.join(' ')} exited ${r.status}: ${r.out.trim().slice(0, 300)}`); return 1; }
  }
  manifest.loaded = true;
  writeFileSync(factoryManifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  out('✓ loaded (`dexterm autotrade factory status`)');
  return 0;
}

async function uninstallCmd(argv: string[], io: AutotradeIo, deps: FactoryCmdDeps): Promise<number> {
  const { opts } = parseArgs(argv, ['dry-run', 'force']);
  const home = dextermHome(io.env);
  const m = readManifest(home);
  const out = (s: string) => io.stdout.write(`${s}\n`);
  if (!m) { out(`nothing installed for this home (no ${factoryManifestPath(home)})`); return 0; }
  if (opts['dry-run']) { out(`would run ${m.deactivate.map((c) => c.join(' ')).join(' && ')} and remove:`); for (const f of m.files) out(`  ${f.path}`); return 0; }
  const ex = deps.exec ?? defaultExec;
  for (const c of m.deactivate) { const x = ex(c); out(`${c.join(' ')}: ${x.status === 0 ? 'ok' : `exit ${x.status} (${x.out.trim().slice(0, 120) || 'not loaded'})`}`); }
  let kept = 0;
  for (const f of m.files) {
    if (!existsSync(f.path)) { out(`already gone: ${f.path}`); continue; }
    const sha = createHash('sha256').update(readFileSync(f.path)).digest('hex');
    if (sha !== f.sha256 && !opts.force) { kept++; errOut(io, `kept ${f.path}: it changed since install (remove it yourself, or --force)`); continue; }
    rmSync(f.path, { force: true });
    out(`removed ${f.path}`);
  }
  if (kept) return 1;
  rmSync(factoryManifestPath(home), { force: true });
  out(`✓ uninstalled: no scheduled factory runs${factoryStopped(home) ? ' (FACTORY-STOP is still there)' : ''}`);
  return 0;
}

