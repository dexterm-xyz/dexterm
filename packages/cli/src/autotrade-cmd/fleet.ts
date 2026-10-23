// `dexterm autotrade run --all --paper` (task-1529): every strategy of autotrade.json at the same time, on ONE data
// feed. PAPER ONLY.
//
// The host around @dexterm/autotrade runFleet (fleet.ts): one process, one runner lock under the fleet's run id, one
// live data layer (or one paced tape), one shared dossier cache, one machine-load check and the global caps of
// autotrade.json; each strategy gets its own run id, ledger (autotrade/runs/<runId>.jsonl), simulated book (its own
// bankroll), breaker, sessions and spend budget.
//
// Files it writes, every heartbeat (10 s) and on change (throttled to 1 s):
//   autotrade/runner-status.json   the runner rendezvous, as an AGGREGATE of every strategy (book summed, positions /
//                                  candidates / sessions tagged with their strategy), under the fleet's run id: the
//                                  Q screen's runner view, `dexterm autotrade stop|flatten`, the monitor's dead-man and
//                                  the MCP autotrade_status read it unchanged
//   autotrade/fleet-status.json    each strategy's state, book, spend and stats, the global caps and their use today
//   autotrade/runs/<id>.summary.json  each strategy's run summary and the fleet's (for `dexterm autotrade audit`)
//
// Paper accounts (task-1538): autotrade.json `accounts` are shared simulated wallets; a strategy with `account` trades
// from that wallet's cash (and one strategy can run on several accounts). Printed as their own table at the end.
//
// Switches: the panic file, `dexterm autotrade stop | flatten` and the Q screen's `!` / `f` / `p` act on EVERY strategy
// (the fleet's RunnerSafety); `dexterm autotrade stop | flatten | pause | resume --strategy ID` and `start ID` act on one
// (fleet-control.ts). Nothing here arms a mandate, signs, holds a key or touches a wallet; `--live` and `mode: live`
// are refused (task-1571: dexterm places no live order).

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dextermHome } from '@dexterm/custom';
import { KillSwitch, createDataLayer, defaultDbPath, resolveRpcUrl } from '@dexterm/data';
import {
  FleetGuard, HEARTBEAT_MS, accountTable, LiveSource, RUNNER_RENDEZVOUS_SCHEMA, RUN_SUMMARY_SCHEMA, RunnerSafety, acquireRunLock, bankrollUsd, claudeSessionFactory, clearControl,
  clearMemberControls, clearStaleControl, compareRows, compareTable, controlPath, fileLedger, fleetStatusPath, fleetTotals, loadFleetConfig, loadRunnerConfig, loadTape,
  memberStrategy, newRunId, prepareAccount, releaseRunLock, renderDossierRecord, runFleet, runFiles, runnerRendezvousPath, runnerSystemPrompt, sharedDossier, stubSession,
  writeJsonAtomic, writeRendezvous,
  type FleetHooks, type FleetMemberSpec, type FleetStatus, type MarketTick, type MemberGate, type RunSessionFactory, type RunnerRendezvous, type RunnerState, type VetFn,
} from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs, resolveStrategyArg } from './strategies.ts';
import { larpVet } from './run.ts';

export const FLEET_RUN_USAGE = 'dexterm autotrade run --all --paper [--config FILE] [--replay TAPE [--ms-per-tick 2000]] [--sol-usd N] [--model M] [--max-minutes N] [--stub] [--raw] [--quiet]';

const BOOL = ['all', 'paper', 'live', 'stub', 'quiet', 'raw'];
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function num(v: string | true | undefined, dflt: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Test seams: the panic switch, the load average, extra hooks (the chat notify bus attaches here), sessions. */
export interface FleetRunOverrides {
  killSwitch?: KillSwitch;
  loadavg?: () => number;
  hooks?: FleetHooks;
  sessions?: (m: FleetMemberSpec, gate: MemberGate, log: (kind: string, data: Record<string, unknown>) => void, clock: () => number) => RunSessionFactory;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The single-runner rendezvous shape, filled with every strategy together (the existing readers need no change). */
export function aggregateRendezvous(st: FleetStatus, states: ReadonlyMap<string, RunnerState>, tails: { t: number; kind: string; text: string; member: string }[]): Omit<RunnerRendezvous, 'heartbeatAt'> & { fleet: { fleetId: string; strategies: number; statusPath: string } } {
  const tot = fleetTotals(st);
  const live = st.members.filter((m) => m.runId && m.state !== 'stopped' && m.state !== 'error' && m.state !== 'idle');
  const runnerState: RunnerState['state'] = st.state === 'stopped' ? 'stopped' : st.state === 'halted' ? 'halted'
    : live.length && live.every((m) => m.state === 'paused' || m.state === 'halted') ? 'paused' : 'running';
  const each = <T>(pick: (s: RunnerState) => T[], m: string) => (states.get(m) ? pick(states.get(m)!) : []);
  const ids = st.members.map((m) => m.id);
  return {
    schema: RUNNER_RENDEZVOUS_SCHEMA, pid: st.pid, mode: 'paper', runId: st.fleetId, startedAt: st.startedAt, ledgerPath: st.ledgerPath,
    state: runnerState, haltReason: st.haltReason ?? (st.global.blocked ? `fleet: ${st.global.blocked}` : st.global.load.paused ? 'fleet-load-high' : null),
    strategy: { id: 'parallel', version: `${st.members.length} strategies`, hash: st.fleetId.slice(-4) },
    book: { startUsd: tot.startUsd, equityUsd: tot.equityUsd, cashUsd: tot.cashUsd, realizedTodayUsd: round2(st.members.reduce((a, m) => a + (m.book?.realizedTodayUsd ?? 0), 0)) },
    spend: {
      todayUsd: st.global.today.modelUsd, dayCapUsd: st.global.caps.modelUsdPerDay, turnsToday: st.global.today.turns,
      candidateSessionsToday: st.global.today.candidateSessions, positionSessionsToday: st.global.today.positionSessions, allowance: st.global.allowance,
    },
    candidates: ids.flatMap((m) => each((s) => s.candidates, m).map((c) => ({ ...c, strategy: m }))),
    sessions: ids.flatMap((m) => each((s) => s.sessions, m).map((x) => ({ ...x, id: `${m}:${x.id}`, strategy: m }))),
    positions: ids.flatMap((m) => each((s) => s.positions, m).map((p) => ({ ...p, strategy: m }))),
    ledgerTail: tails.slice(-12).map((e, i) => ({ seq: i + 1, t: e.t, kind: e.kind, text: `[${e.member}] ${e.text}` })),
    ledgerHead: '', events: st.members.reduce((a, m) => a + (states.get(m.id)?.events ?? 0), 0),
    fleet: { fleetId: st.fleetId, strategies: st.members.length, statusPath: '' },
  };
}

export async function fleetRunCmd(argv: string[], io: AutotradeIo, over: FleetRunOverrides = {}): Promise<number> {
  const { pos, opts } = parseArgs(argv, BOOL);
  if (opts.live) { io.stderr.write('dexterm autotrade run --all: live money is not available; parallel strategies run on paper only (--paper)\n'); return 2; }
  if (!opts.paper) { io.stderr.write(`dexterm autotrade run --all: pass --paper (autotrade runs on paper only)\nusage: ${FLEET_RUN_USAGE}\n`); return 2; }
  if (pos.length || typeof opts.strategy === 'string') { io.stderr.write(`dexterm autotrade run --all runs every strategy listed in autotrade.json; name no strategy here\nusage: ${FLEET_RUN_USAGE}\n`); return 2; }

  const home = dextermHome(io.env);
  const kill = over.killSwitch ?? new KillSwitch();
  const panic = kill.engaged();
  if (panic) { io.stderr.write(`dexterm autotrade run --all: the panic switch is engaged (${panic.reason}); nothing starts until you run \`dexterm wallet resume\` in a terminal\n`); return 1; }
  const rc = loadRunnerConfig(home);
  if (!rc.ok) { io.stderr.write(`dexterm autotrade run --all: ${rc.path} is invalid:\n${rc.errors.map((e) => `  ${e}`).join('\n')}\n`); return 1; }
  const runnerCfg = rc.config;
  const fc = loadFleetConfig(home, typeof opts.config === 'string' ? opts.config : undefined);
  if (!fc.ok) {
    io.stderr.write(`dexterm autotrade run --all: ${fc.path}:\n${fc.errors.map((e) => `  ${e}`).join('\n')}\n`);
    if ('missing' in fc) io.stderr.write('  example:\n  { "schema": "dexterm-autotrade/1",\n    "strategies": [ { "id": "moon-a", "preset": "moonbag", "bankroll": { "usd": 500 } },\n                    { "id": "scalp-b", "preset": "scalp", "bankroll": { "sol": 1 } } ],\n    "global": { "maxConcurrentSessions": 3, "modelUsdPerDay": 10 } }\n  shared paper accounts (many strategies on one simulated wallet, one strategy on many):\n  { "schema": "dexterm-autotrade/1",\n    "accounts": [ { "id": "main", "bankroll": { "usd": 1000 } }, { "id": "yolo", "bankroll": { "sol": 1 } } ],\n    "strategies": [ { "id": "moon", "preset": "moonbag", "account": "main" },\n                    { "id": "scalp", "preset": "scalp", "account": ["main", "yolo"] } ] }\n');
    return 1;
  }
  const fleetCfg = fc.config;
  const enabled = fleetCfg.strategies.filter((m) => m.enabled);
  if (!enabled.length) { io.stderr.write(`dexterm autotrade run --all: every strategy in ${fc.path} is "enabled": false; nothing to run\n`); return 1; }

  const replay = typeof opts.replay === 'string' ? opts.replay : null;
  const quiet = !!opts.quiet;
  const say = (s: string) => { if (!quiet) io.stdout.write(`${s}\n`); };

  // The market first (a SOL bankroll needs the SOL price before the books are built).
  let tape: ReturnType<typeof loadTape> | undefined;
  let data: ReturnType<typeof createDataLayer> | null = null;
  if (replay) {
    try { tape = loadTape(replay); } catch (e) { io.stderr.write(`dexterm autotrade run --all: ${(e as Error).message}\n`); return 1; }
  } else {
    const rpc = resolveRpcUrl({ env: io.env });
    data = createDataLayer({ dbPath: io.env.DEXTERM_DB_PATH || defaultDbPath(io.env), rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl });
  }
  const closeData = () => { try { data?.close(); } catch { /* closing */ } };
  let solUsd: number | null = typeof opts['sol-usd'] === 'string' ? num(opts['sol-usd'], NaN) : fleetCfg.solUsd ?? null;
  if (Number.isNaN(solUsd)) { io.stderr.write('dexterm autotrade run --all: --sol-usd needs a positive number\n'); closeData(); return 2; }
  if (solUsd === null && data && (fleetCfg.strategies.some((m) => m.bankroll && 'sol' in m.bankroll) || (fleetCfg.accounts ?? []).some((a) => 'sol' in a.bankroll))) {
    try { const p = (await data.dexscreener.tokens([SOL_MINT])).get(SOL_MINT)?.pair.priceUsd ?? null; solUsd = p && p > 1 && p < 100_000 ? p : null; } catch { solUsd = null; }
  }

  // Every strategy resolves, or nothing starts (fail closed: a typo never leaves one strategy silently out).
  const members: FleetMemberSpec[] = [];
  const problems: string[] = [];
  // Shared paper accounts (task-1538): each one's starting balance in USD (a SOL balance at the SOL price).
  const accounts: { id: string; startUsd: number; sol?: number; solUsd?: number }[] = [];
  for (const a of fleetCfg.accounts ?? []) {
    const b = bankrollUsd(a.bankroll, solUsd);
    if (b.error || b.usd === null) { problems.push(`paper account ${a.id}: ${b.error ?? 'no balance'}`); continue; }
    accounts.push({ id: a.id, startUsd: b.usd, ...('sol' in a.bankroll ? { sol: a.bankroll.sol, solUsd: solUsd! } : {}) });
  }
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  for (const m of fleetCfg.strategies) {
    const r = resolveStrategyArg(m.preset ?? m.file, io);
    if (!r || !r.ok) { problems.push(`${m.id}: ${r ? r.errors.map((e) => `${e.path || '/'} ${e.msg}`).join('; ') : 'no strategy'}`); continue; }
    if (r.strategy.mode !== 'paper') { problems.push(`${m.id}: ${r.strategy.id} is mode "${r.strategy.mode}"; the runner refuses anything but paper`); continue; }
    const acct = m.account ? accountOf.get(m.account) : undefined;
    if (m.account && !acct) continue; // its account already failed above
    const b = acct ? { usd: acct.startUsd } : bankrollUsd(m.bankroll, solUsd);
    if ('error' in b && b.error) { problems.push(`${m.id}: ${b.error}`); continue; }
    const { strategy, basedOn } = memberStrategy(r.strategy, m, b.usd);
    const sol = acct ? (acct.sol !== undefined ? { sol: acct.sol, solUsd: acct.solUsd! } : {}) : m.bankroll && 'sol' in m.bankroll ? { sol: m.bankroll.sol, solUsd: solUsd! } : {};
    members.push({ config: m, strategy, basedOn, bankroll: { usd: strategy.bankroll.startUsd, ...sol } });
  }
  if (problems.length) { io.stderr.write(`dexterm autotrade run --all: nothing started:\n${problems.map((p) => `  ${p}`).join('\n')}\n`); closeData(); return 1; }

  const fleetId = newRunId('fleet');
  const lock = acquireRunLock(home, fleetId);
  if (!lock.ok) { io.stderr.write(`dexterm autotrade run --all: another runner is active (pid ${lock.holder.pid}, run ${lock.holder.runId}); stop it first\n`); closeData(); return 1; }
  if (lock.reclaimed) say(`reclaimed a stale runner lock (pid ${lock.reclaimed.pid} is gone)`);
  if (!clearStaleControl(home, fleetId)) { io.stderr.write(`dexterm autotrade run --all: ${controlPath(home)} cannot be read; look at it and remove it, then start again\n`); releaseRunLock(home, fleetId); closeData(); return 1; }
  clearMemberControls(home, fleetId);

  const { ledger: fleetLedger, files: fleetFiles } = fileLedger(home, fleetId);
  const startedAt = Date.now();
  const guard = new FleetGuard(fleetCfg.global, runnerCfg, { loadavg: over.loadavg });
  const rawPath = opts.raw ? join(home, 'autotrade', 'runs', `${fleetId}.stream.jsonl`) : null;
  const sessions = over.sessions ?? (opts.stub
    ? () => stubSession() as RunSessionFactory
    : (m: FleetMemberSpec, gate: MemberGate, log: (kind: string, d: Record<string, unknown>) => void, clock: () => number): RunSessionFactory => claudeSessionFactory({
      bin: typeof opts['claude-bin'] === 'string' ? opts['claude-bin'] : (io.env.DEXTERM_CLAUDE_BIN || 'claude'),
      account: () => prepareAccount(runnerCfg.account, io.env),
      model: typeof opts.model === 'string' ? opts.model : undefined,
      systemPrompt: (s) => runnerSystemPrompt(s, { live: !replay }),
      gate, log,
      onRaw: rawPath ? (id, line) => appendFileSync(rawPath, `${JSON.stringify({ strategy: m.config.id, sessionId: id, line })}\n`, { mode: 0o600 }) : undefined,
      now: clock,
    }));

  let live: LiveSource | null = null;
  let source: { name: string; ticks: AsyncIterable<MarketTick>; startT?: number; setFocus?: (f: { mint: string; role: 'held' | 'candidate' }[]) => void } | undefined;
  let dossier: ((m: FleetMemberSpec) => import('@dexterm/autotrade').DossierFn | undefined) | undefined;
  let vet: ((m: FleetMemberSpec) => VetFn | undefined) | undefined;
  if (data) {
    live = new LiveSource({ store: data.store, dexscreener: data.dexscreener }, { onLog: (l) => fleetLedger.add(Date.now(), 'source_error', { error: l.slice(0, 300) }) });
    const ls = live;
    source = { name: 'live keyless data layer (Store + DexScreener tokens/v1 fast lane), shared by every strategy', ticks: ls.ticks(), startT: startedAt, setFocus: (marks) => { ls.setFocus(marks); writeFocus(home, marks); } };
    // One dossier record per coin per 30 s, whichever strategy asks; each strategy renders its own text.
    const { McpTools } = await import('@dexterm/mcp');
    const mcp = new McpTools(data, () => ({ screen: 'autotrade-runner', actions: { mints: [], feeds: [], sortKeys: [] } }));
    const shared = sharedDossier(async (mint) => {
      try { return await mcp.call('get_dossier', { mint, interval: '5m' }); } catch (e) { return { availability: { present: [], missing: [`dossier: ${(e as Error).message}`], knownUnavailable: [] } } as Record<string, unknown>; }
    });
    dossier = () => async (k, h, matched, b) => renderDossierRecord(await shared.get(k.mint), { mint: k.mint, symbol: k.symbol, matched }, k, h, b);
    // A member's LARP gate (entry.safety.larp, the yolo preset's) on live data, as `autotrade run` has it.
    vet = fleetLarpVet((mint) => mcp.call('larp_check', { mint }));
  }

  // Heartbeat: the aggregate rendezvous, the fleet status, every summary.
  const states = new Map<string, RunnerState>();
  const runOf = new Map<string, string>();
  const tails: { t: number; kind: string; text: string; member: string }[] = [];
  let lastStatus: FleetStatus | null = null;
  let lastWrite = 0;
  let lastBeatOk = startedAt;
  let beatFailing = false;
  const writeAll = (force = false) => {
    const st = lastStatus;
    if (!st) return;
    const now = Date.now();
    if (!force && now - lastWrite < 1000) return;
    lastWrite = now;
    try {
      const agg = aggregateRendezvous(st, states, tails);
      agg.fleet.statusPath = fleetStatusPath(home);
      writeRendezvous(home, { ...agg, heartbeatAt: now } as RunnerRendezvous);
      writeJsonAtomic(fleetStatusPath(home), { ...st, heartbeatAt: now });
      writeJsonAtomic(fleetFiles.summary, { schema: RUN_SUMMARY_SCHEMA, runId: fleetId, strategy: { id: 'parallel', version: `${st.members.length} strategies`, hash: '' }, startedAt, updatedAt: now, state: st.state, book: agg.book, spend: agg.spend, events: fleetLedger.events.length, ledgerHead: fleetLedger.head(), source: st.source });
      for (const m of st.members) {
        const s = states.get(m.id);
        const runId = runOf.get(m.id);
        if (!s || !runId) continue;
        writeJsonAtomic(runFiles(home, runId).summary, { schema: RUN_SUMMARY_SCHEMA, runId, strategy: s.strategy, startedAt: m.startedAt, updatedAt: now, state: s.state, book: s.book, spend: s.spend, events: s.events, ledgerHead: s.ledgerHead, source: st.source, fleetId });
      }
      lastBeatOk = now;
      if (beatFailing) { beatFailing = false; fleetLedger.add(now, 'heartbeat_ok', {}); }
    } catch (e) {
      if (!beatFailing) { beatFailing = true; fleetLedger.add(now, 'heartbeat_failed', { error: (e as Error).message.slice(0, 200) }); }
    }
  };
  const beat = setInterval(() => writeAll(true), HEARTBEAT_MS);

  const maxMin = num(opts['max-minutes'], 0);
  const stopAt = maxMin ? startedAt + maxMin * 60_000 : Infinity;
  let stopping = false;
  const stop = (why: string) => { if (stopping) return; stopping = true; fleetLedger.add(Date.now(), 'stop_requested', { why }); say(`stopping every strategy (${why}): open sessions close, each paper book is kept in its ledger`); live?.stop(); };
  const onSig = () => stop('signal');
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  const safety = new RunnerSafety({ home, runId: fleetId, killSwitch: kill, heartbeatAgeMs: () => (beatFailing ? Date.now() - lastBeatOk : 0) });

  say(`dexterm autotrade run --all · PAPER · ${members.length} strategies at once (${enabled.length} enabled) · ${replay ? `replay ${replay}` : 'live keyless data, one feed for all'} · sessions ${opts.stub ? 'stub' : `claude (${runnerCfg.account.kind}${typeof opts.model === 'string' ? `, ${opts.model}` : ''})`}`);
  if (accounts.length) say(`paper accounts: ${accounts.map((a) => `${a.id} $${a.startUsd}${a.sol !== undefined ? ` (${a.sol} SOL)` : ''} ← ${members.filter((m) => m.config.account === a.id).map((m) => m.config.id).join(', ') || 'no strategy'}`).join(' · ')}`);
  // The single run's HIGH RISK line (task-1532), for every yolo-like member of the fleet (paper only here).
  const risky = members.filter((m) => m.strategy.highRisk).map((m) => m.config.id);
  if (risky.length) say(`⚠ HIGH RISK strateg${risky.length === 1 ? 'y' : 'ies'} (${risky.join(', ')}): one position at a time, early entries, most of them lose. Experimental; can lose all funds; not financial advice.`);
  say(`fleet ${fleetId} · global caps: ${guard.caps.maxConcurrentSessions} sessions at once, $${guard.caps.modelUsdPerDay}/day model spend, ${guard.caps.candidateSessionsPerDay} candidate sessions/day · ledger ${fleetFiles.ledger}`);
  let code = 0;
  try {
    const res = await runFleet({
      fleetId, home, members, tape, source, runner: runnerCfg, guard, fleetLedger, fleetLedgerPath: fleetFiles.ledger, ...(accounts.length ? { accounts } : {}),
      pacing: replay ? { mode: 'paced', msPerTick: num(opts['ms-per-tick'], 2000) } : { mode: 'live' },
      sessions, dossier, vet, newRunId: (id) => newRunId(id), verbose: true, onLine: say,
      globalSafety: () => {
        if (Date.now() >= stopAt) stop('max-minutes');
        const v = safety.step();
        return stopping && !v.halt ? { ...v, halt: 'runner-stopped', detail: 'a signal or --max-minutes', endWhenFlat: true } : v;
      },
      hooks: {
        onMemberEvent: (m, runId, e) => {
          runOf.set(m, runId);
          if (['candidate', 'fill', 'trade_closed', 'halt', 'refused', 'session_start', 'session_end', 'entries_paused', 'entries_resumed', 'stuck'].includes(e.kind)) {
            tails.push({ t: e.t, kind: e.kind, member: m, text: tailLine(e) });
            if (tails.length > 48) tails.splice(0, tails.length - 24);
          }
          over.hooks?.onMemberEvent?.(m, runId, e);
        },
        onMemberState: (m, runId, s) => { runOf.set(m, runId); states.set(m, s); over.hooks?.onMemberState?.(m, runId, s); },
        onFleetState: (st) => { lastStatus = st; writeAll(st.state === 'stopped'); over.hooks?.onFleetState?.(st); },
      },
    });
    const rows = compareRows(res.status);
    say('');
    for (const l of compareTable(rows)) say(l);
    const acctLines = accountTable(res.status);
    if (acctLines.length) { say(''); for (const l of acctLines) say(l); }
    const tot = fleetTotals(res.status);
    say(`done · ${members.length} strategies · together ${tot.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(tot.pnlUsd).toFixed(2)} on $${tot.startUsd.toFixed(2)} (paper) · $${tot.spendUsd.toFixed(4)} model spend · fleet ledger head ${fleetLedger.head()}`);
  } catch (e) {
    io.stderr.write(`dexterm autotrade run --all: ${(e as Error).message}\n`);
    code = 1;
  } finally {
    clearInterval(beat);
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
    if (lastStatus && (lastStatus as FleetStatus).state !== 'stopped') lastStatus = { ...(lastStatus as FleetStatus), state: 'stopped' };
    writeAll(true);
    writeFocus(home, []);
    live?.stop();
    closeData();
    clearControl(home, fleetId);
    clearMemberControls(home, null);
    releaseRunLock(home, fleetId);
  }
  return code;
}

/** One short line for the aggregate ledger tail (no message text). */
function tailLine(e: Record<string, unknown>): string {
  const v = (k: string) => (e[k] === undefined || e[k] === null ? '' : String(e[k]).slice(0, 40));
  switch (e.kind) {
    case 'candidate': return `candidate ${v('symbol')}`;
    case 'fill': return `${v('side')} $${Number(e.usd ?? 0).toFixed(2)} ${v('reason')}`;
    case 'trade_closed': { const t = e.trade as { symbol?: string; pnlUsd?: number; exitReason?: string } | undefined; return `closed ${t?.symbol ?? ''} ${(t?.pnlUsd ?? 0) >= 0 ? '+' : '-'}$${Math.abs(t?.pnlUsd ?? 0).toFixed(2)} by ${t?.exitReason ?? ''}`; }
    case 'refused': return `refused ${v('rule')}`;
    default: return [v('reason'), v('sessionId'), v('rule')].filter(Boolean).join(' ') || String(e.kind);
  }
}

/** Candidate + held coins of every strategy for the recorder's tick lane (task-1504 focus file); best effort. */
function writeFocus(home: string, marks: { mint: string; role: 'held' | 'candidate' }[]): void {
  void import('@dexterm/recorder').then((m) => {
    try { m.writeFocusFile(m.focusFilePath(home), marks.map((x) => ({ mint: x.mint, role: x.role, until: Date.now() + 30 * 60_000 })), Date.now()); } catch { /* the recorder is optional */ }
  }).catch(() => {});
}

/**
 * The fleet's LARP gate per member (entry.safety.larp, e.g. the yolo preset), on live data only, as `autotrade run` has
 * it: without it a gated strategy would open candidates unchecked under `run --all`. One larp_check per coin for the
 * whole fleet; each member applies its own maxScore / unknown, and a check that throws is not kept (the next asks again).
 */
export function fleetLarpVet(check: (mint: string) => Promise<Record<string, unknown>>): (m: FleetMemberSpec) => VetFn | undefined {
  const byMint = new Map<string, Promise<Record<string, unknown>>>();
  const shared = (mint: string) => {
    let p = byMint.get(mint);
    if (!p) { p = check(mint); byMint.set(mint, p); p.catch(() => byMint.delete(mint)); }
    return p;
  };
  return (m) => (m.strategy.entry.safety.larp ? larpVet(m.strategy.entry.safety.larp, shared) : undefined);
}
