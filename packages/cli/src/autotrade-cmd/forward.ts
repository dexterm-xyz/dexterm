// `dexterm autotrade forward start|status|stop|report` (0.2.0 card C). PAPER ONLY.
//
// A forward test is one strategy, frozen at its current version, on the LIVE tape, on paper, with its own bankroll and
// run file, for a window of hours or N closed trades (whichever comes first). `start` freezes it and starts its host
// detached (`forward run <fid>`, output in autotrade/forward/tests/<fid>.log); `--foreground` runs it in this terminal.
// It does not take the machine's run lock, so it runs next to the always-on service. At the end of the window the
// host flattens and writes the report: the forward numbers next to the backtest (held-out split) of the same rules.
// `--replay TAPE` is a smoke run on a recorded tape: labelled, never counted as the forward-tested rung.
//
// The analyst starts and stops the same tests (strategy_forward_start / _stop, never with a bankroll of its choosing);
// the Q screen's journey view shows them. Nothing here holds a key, signs or touches a wallet.

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dextermHome, loadConfig } from '@dexterm/custom';
import { pickBasis } from '@dexterm/data/basis';
import { KillSwitch, createDataLayer, defaultDbPath, resolveRpcUrl } from '@dexterm/data';
import {
  LiveSource, SessionGate, builtinTapePath, claudeSessionFactory, createForwardTest, effectiveCaps, findForwardTest, forwardLogPath, forwardReport, hostForward, liveState, listForwardTests,
  loadForwardTest, loadRunnerConfig, loadTape, markLost, prepareAccount, renderDossierRecord, requestForwardStop, runnerSystemPrompt, saveForwardTest, stubSession, validateStrategy, windowText,
  type DossierFn, type ForwardTest, type RunSessionFactory, type Strategy, type VetFn,
} from '@dexterm/autotrade';
import { ollamaSessionFactory } from '@dexterm/autotrade/ollama';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs, storeFor } from './strategies.ts';
import { larpVet, localEngine } from './run.ts';

const BOOL = ['json', 'stub', 'foreground', 'yes'];
export const FORWARD_USAGE = [
  'dexterm autotrade forward start <id> [--hours H] [--trades N] [--bankroll-usd N] [--foreground] [--stub] [--engine claude|ollama] [--model M] [--replay TAPE [--ms-per-tick N]]',
  'dexterm autotrade forward status [<id|fid>] [--json]',
  'dexterm autotrade forward stop <id|fid>',
  'dexterm autotrade forward report <id|fid> [--json]',
];

const out = (io: AutotradeIo, s: string) => { io.stdout.write(`${s}\n`); };
const err = (io: AutotradeIo, s: string) => { io.stderr.write(`dexterm autotrade forward: ${s}\n`); };
const num = (v: string | true | undefined): number | null => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** The dexterm entry point a detached host runs (this package's bin). */
export const DEXTERM_BIN = fileURLToPath(new URL('../../bin/dexterm.mjs', import.meta.url));

/** Start the host of a `starting` test detached; its output goes to the test's log file. Returns the pid. */
export function spawnForwardHost(home: string, t: ForwardTest, env: NodeJS.ProcessEnv, extra: string[] = [], bin = DEXTERM_BIN): number | null {
  const fd = openSync(forwardLogPath(home, t.forwardId), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [bin, 'autotrade', 'forward', 'run', t.forwardId, ...extra], { detached: true, stdio: ['ignore', fd, fd], env: { ...env, DEXTERM_HOME: home } });
    child.unref();
    return child.pid ?? null;
  } finally { closeSync(fd); }
}

export interface ForwardDeps {
  /** Tests: start the host (default: detached child process). */
  spawnHost?: (home: string, t: ForwardTest, extra: string[]) => number | null;
  killSwitch?: KillSwitch;
  now?: () => number;
}

export async function forwardCmd(argv: string[], io: AutotradeIo, deps: ForwardDeps = {}): Promise<number> {
  const [sub, ...rest] = argv;
  const home = dextermHome(io.env);
  const now = deps.now ?? Date.now;
  switch (sub) {
    case 'start': return startCmd(rest, io, home, deps, now);
    case 'run': return runHostCmd(rest, io, home, deps);
    case 'status': case undefined: return statusCmd(rest, io, home, now);
    case 'stop': {
      const ref = rest.find((a) => !a.startsWith('--'));
      if (!ref) { err(io, 'usage: dexterm autotrade forward stop <id|fid>'); return 2; }
      const t = findForwardTest(home, ref, now());
      if (!t) { err(io, `no forward test for ${JSON.stringify(ref)}`); return 1; }
      const r = requestForwardStop(home, t.forwardId, 'cli', now());
      if (!r.ok) { err(io, r.why); return 1; }
      out(io, `${r.already ? 'already asked to stop' : 'stop requested'}: ${t.forwardId} (${t.strategyId}) flattens at its next tick, writes its report and ends. A test stopped early is shown, not counted. Report: dexterm autotrade forward report ${t.forwardId}`);
      return 0;
    }
    case 'report': return reportCmd(rest, io, home, now);
    case 'help': case '--help': case '-h': out(io, FORWARD_USAGE.join('\n')); return 0;
    default: err(io, `unknown subcommand ${JSON.stringify(sub)}\n${FORWARD_USAGE.join('\n')}`); return 2;
  }
}

async function startCmd(argv: string[], io: AutotradeIo, home: string, deps: ForwardDeps, now: () => number): Promise<number> {
  const { pos, opts } = parseArgs(argv, BOOL);
  const id = pos[0];
  if (!id) { err(io, `usage: ${FORWARD_USAGE[0]}`); return 2; }
  if (opts.real || opts.live) { err(io, 'a forward test is paper only (a real strategy forward-tests as its paper twin)'); return 2; }
  const store = storeFor(io);
  const got = store.get(id);
  if (!got) { err(io, `no strategy ${JSON.stringify(id)} (dexterm autotrade list)`); return 1; }
  if (!got.ok) { err(io, `${id} does not validate: ${got.errors.map((e) => `${e.path} ${e.msg}`).join('; ')}`); return 1; }
  const raw = store.raw(id) as Strategy;
  const replay = typeof opts.replay === 'string' ? opts.replay : null;
  const hours = num(opts.hours);
  const trades = num(opts.trades);
  if (opts.hours !== undefined && hours === null) { err(io, '--hours needs a number'); return 2; }
  if (opts.trades !== undefined && trades === null) { err(io, '--trades needs a whole number'); return 2; }
  const c = createForwardTest(home, got.strategy, raw, {
    hours: hours ?? (trades === null ? 24 : null), trades, bankrollUsd: num(opts['bankroll-usd']), by: 'user', now: now(),
    source: replay ? `replay ${replay}` : 'live', stub: !!opts.stub, msPerTick: num(opts['ms-per-tick']),
  });
  if (!c.ok) { err(io, c.why); return 1; }
  const t = c.test;
  out(io, `forward test ${t.forwardId} · ${id} v${t.version} · PAPER · ${replay ? `replay ${replay} (a smoke run: it does not count as a forward test)` : 'live keyless data'} · own bankroll $${t.bankrollUsd} · window ${windowText(t.window)}`);
  const extra = [...(opts.stub ? ['--stub'] : []), ...(typeof opts.engine === 'string' ? ['--engine', opts.engine] : []), ...(typeof opts.model === 'string' ? ['--model', opts.model] : [])];
  if (opts.foreground) return runHostCmd([t.forwardId, ...extra], io, home, deps);
  const pid = (deps.spawnHost ?? ((h, x, e) => spawnForwardHost(h, x, io.env, e)))(home, t, extra);
  // The host writes its own pid when it starts; only a test it has not picked up yet gets the spawn pid (liveness).
  const cur = loadForwardTest(home, t.forwardId);
  if (pid && cur && cur.state === 'starting' && cur.pid === null) saveForwardTest(home, { ...cur, pid });
  out(io, `started in the background${pid ? ` (pid ${pid})` : ''} · log ${forwardLogPath(home, t.forwardId)}`);
  out(io, `  status: dexterm autotrade forward status ${id} · stop: dexterm autotrade forward stop ${id} · report: dexterm autotrade forward report ${id}`);
  return 0;
}

/** The host (`forward run <fid>`): the live data layer (or a replay), sessions, the panic file; then hostForward. */
async function runHostCmd(argv: string[], io: AutotradeIo, home: string, deps: ForwardDeps): Promise<number> {
  const { pos, opts } = parseArgs(argv, BOOL);
  const fid = pos[0];
  const t = fid ? loadForwardTest(home, fid) : null;
  if (!t) { err(io, `no forward test ${JSON.stringify(fid ?? '')}`); return 1; }
  if (t.state !== 'starting') { err(io, `${t.forwardId} is ${t.state}; a forward test runs once (start a new one)`); return 1; }
  const fail = (why: string) => { saveForwardTest(home, { ...t, state: 'failed', endedAt: Date.now(), endReason: why }); err(io, why); return 1; };
  const kill = deps.killSwitch ?? new KillSwitch();
  const panic = kill.engaged();
  if (panic) return fail(`the panic switch is engaged (${panic.reason}); nothing starts until \`dexterm wallet resume\``);
  const v = validateStrategy(t.doc);
  if (!v.ok) return fail('the frozen strategy does not validate');
  const strategy = v.strategy;
  const cfg = loadRunnerConfig(home);
  if (!cfg.ok) return fail(`${cfg.path} is invalid: ${cfg.errors.join('; ')}`);
  const basis = pickBasis(loadConfig(home).config.display?.priceMode, io.env);
  const replay = t.source.startsWith('replay ') ? t.source.slice('replay '.length) : null;
  const stub = t.stub || !!opts.stub;
  const gate = new SessionGate(effectiveCaps(strategy, cfg.config), cfg.config.allowanceGuard);
  const say = (s: string) => out(io, s);
  let sessions: RunSessionFactory | null;
  if (stub) sessions = stubSession();
  else {
    const eng = await localEngine(opts, io);
    if ('error' in eng) return fail(eng.error);
    sessions = eng.engine === 'ollama'
      ? ollamaSessionFactory({ client: eng.client, model: eng.model, numCtx: eng.numCtx, restriction: eng.level, live: false, systemPrompt: (s) => runnerSystemPrompt(s, { live: !replay, basis }), gate, log: () => {} })
      : claudeSessionFactory({ bin: io.env.DEXTERM_CLAUDE_BIN || 'claude', account: () => prepareAccount(cfg.config.account, io.env), model: typeof opts.model === 'string' ? opts.model : undefined, systemPrompt: (s) => runnerSystemPrompt(s, { live: !replay, basis }), gate, log: () => {} });
  }
  if (replay) {
    let tape;
    try { tape = loadTape(builtinTapePath(replay)); } catch (e) { return fail((e as Error).message); }
    const r = await hostForward({ home, forwardId: t.forwardId, tape, sessions, gate, pacing: { mode: 'paced', msPerTick: t.msPerTick ?? 200 }, killSwitch: kill, onLine: say });
    if (!r.ok) { err(io, r.why); return 1; }
    for (const l of forwardReport(home, r.test).lines) say(l);
    return 0;
  }
  const rpc = resolveRpcUrl({ env: io.env });
  const data = createDataLayer({ dbPath: io.env.DEXTERM_DB_PATH || defaultDbPath(io.env), rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl });
  const live = new LiveSource({ store: data.store, dexscreener: data.dexscreener }, { onLog: () => {} });
  const { McpTools } = await import('@dexterm/mcp');
  const mcp = new McpTools(data, () => ({ screen: 'autotrade-forward', actions: { mints: [], feeds: [], sortKeys: [] } }));
  const dossier: DossierFn = async (k, h, matched, b) => {
    let rec: Record<string, unknown>;
    try { rec = await mcp.call('get_dossier', { mint: k.mint, interval: '5m' }); } catch (e) { rec = { availability: { present: [], missing: [`dossier: ${(e as Error).message}`], knownUnavailable: [] } }; }
    return renderDossierRecord(rec, { mint: k.mint, symbol: k.symbol, matched }, k, h, b, basis);
  };
  const larp = strategy.entry.safety.larp;
  const vet: VetFn | undefined = larp ? larpVet(larp, (mint) => mcp.call('larp_check', { mint })) : undefined;
  const onSig = () => { requestForwardStop(home, t.forwardId, 'signal'); };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  try {
    const r = await hostForward({
      home, forwardId: t.forwardId, source: { name: 'live keyless data layer', ticks: live.ticks(), startT: Date.now(), stop: () => live.stop() },
      sessions, gate, dossier, vet, pacing: { mode: 'live' }, killSwitch: kill, onLine: say,
    });
    if (!r.ok) { err(io, r.why); return 1; }
    for (const l of forwardReport(home, r.test).lines) say(l);
    return r.test.state === 'failed' ? 1 : 0;
  } finally {
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
    live.stop();
    data.close();
  }
}

function statusCmd(argv: string[], io: AutotradeIo, home: string, now: () => number): number {
  const { pos, opts } = parseArgs(argv, BOOL);
  const ref = pos[0];
  const tests = ref ? [findForwardTest(home, ref, now())].filter((x): x is ForwardTest => !!x) : listForwardTests(home).slice(0, 20);
  if (ref && !tests.length) { err(io, `no forward test for ${JSON.stringify(ref)}`); return 1; }
  const rows = tests.map((t) => ({ forwardId: t.forwardId, strategy: t.strategyId, version: t.version, state: liveState(t, now()), source: t.source, window: windowText(t.window), startedAt: t.startedAt, endsAt: t.endsAt, progress: t.progress, endReason: t.endReason }));
  if (opts.json) { out(io, JSON.stringify({ paper: true, tests: rows }, null, 2)); return 0; }
  if (!rows.length) { out(io, 'no forward tests yet (dexterm autotrade forward start <id> --hours 24)'); return 0; }
  for (const r of rows) {
    const p = r.progress;
    out(io, `${r.forwardId}  ${r.strategy.padEnd(18)} v${r.version}  ${r.state.toUpperCase().padEnd(8)} ${r.window}${p ? ` · ${p.closed} closed, ${p.open} open, equity $${p.equityUsd.toFixed(2)}` : ''}${r.endReason ? ` · ${r.endReason}` : ''}${r.source === 'live' ? '' : ` · ${r.source}`}`);
  }
  return 0;
}

function reportCmd(argv: string[], io: AutotradeIo, home: string, now: () => number): number {
  const { pos, opts } = parseArgs(argv, BOOL);
  const ref = pos[0];
  if (!ref) { err(io, 'usage: dexterm autotrade forward report <id|fid> [--json]'); return 2; }
  let t = findForwardTest(home, ref, now());
  if (!t) { err(io, `no forward test for ${JSON.stringify(ref)}`); return 1; }
  if (liveState(t, now()) === 'lost') t = markLost(home, t, now());
  const r = forwardReport(home, t, now());
  if (opts.json) { out(io, JSON.stringify({ paper: true, ...r }, null, 2)); return 0; }
  for (const l of r.lines) out(io, l);
  return 0;
}
