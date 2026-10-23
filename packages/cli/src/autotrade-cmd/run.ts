// `dexterm autotrade run <id|file> --paper` (task-1505 AT-3, AUTOTRADE-SPEC §4). PAPER ONLY.
//
// Headless, like `dexterm watch` and `dexterm record run`, one per machine (run.lock). Live: the keyless data layer's
// Store feeds MarketTicks (the screener pool every 10 s, candidate and held coins every 5 s). `--replay FILE` paces a
// recorded tape instead (no network for market data). Each candidate gets one session on the user's own `claude`
// (runner.json picks the account), clamped by the strategy; orders fill on the simulated paper book (the paper desk
// executor arrives with the monitor card). Every step goes to $DEXTERM_HOME/autotrade/runs/<runId>.jsonl, and the
// rendezvous $DEXTERM_HOME/autotrade/runner-status.json is rewritten every 10 s for the TUI's runner view.
//
// Nothing here arms a mandate, signs, holds a key or touches a wallet. task-1571: there is no `--live`: dexterm places
// no live order. Live trading happens in the Telegram trading bot of the user's choice.
//
// Telegram (task-1527): when `dexterm telegram setup` stored a token and a chat is paired, the user's own bot starts
// with the run (telegram-host.ts): notify, control through the same control file, and approve-to-trade on paper (a
// strategy with `entry.decide: "agent+approve"`, or approvals on). --no-telegram keeps it off; an agent+approve
// strategy then refuses to start, because no entry could ever be approved.
//
// Safety (task-1509, @dexterm/autotrade safety.ts): every step re-reads the panic file and the control file
// (`dexterm autotrade stop|flatten`, the Q screen's `!` / `f` / `p`); a run refuses to start while the panic file is
// engaged (resume is `dexterm wallet resume`, a keypress on a real terminal); entries pause while the heartbeat cannot
// be written. After a stop or flatten the runner keeps running the mechanical exits and ends once nothing is held.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dextermHome, loadConfig } from '@dexterm/custom';
import { pickBasis } from '@dexterm/data/basis';
import { KillSwitch, createDataLayer, defaultDbPath, resolveRpcUrl } from '@dexterm/data';
import {
  HEARTBEAT_MS, LiveSource, badgeOf, RUNNER_RENDEZVOUS_SCHEMA, RunnerSafety, SessionGate, acquireRunLock, clearControl, clearStaleControl, controlPath, claudeSessionFactory, effectiveCaps, fileLedger, loadRunnerConfig,
  loadTape, newRunId, prepareAccount, releaseRunLock, renderDossierRecord, runAutotrade, runnerRendezvousPath, runnerSystemPrompt, simExecutor, stubSession, writeJsonAtomic,
  writeRendezvous, RUN_SUMMARY_SCHEMA, builtinTapePath, type DossierFn, type MarketTick, type RunnerState, type RunSessionFactory, type VetFn,
} from '@dexterm/autotrade';
import { assertAutotradeAllowed, ollamaSessionFactory } from '@dexterm/autotrade/ollama';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs, resolveStrategyArg } from './strategies.ts';
import { startTelegramHost, type TelegramHost, type TelegramHostOpts } from './telegram-host.ts';

const BOOL = ['paper', 'live', 'stub', 'verbose', 'quiet', 'raw', 'no-telegram'];

export const RUN_USAGE = 'dexterm autotrade run <id|file> --paper [--replay TAPE [--ms-per-tick 2000]] [--engine claude|ollama] [--model M] [--max-minutes N] [--stub] [--raw] [--quiet] [--no-telegram]';

/** task-1571: what `--live` says. dexterm holds no key and places no live order. */
export const NO_LIVE = 'dexterm autotrade run: there is no --live: dexterm runs strategies on paper only and never holds a key or signs; live trading happens in the Telegram trading bot of your choice (your own bot gets the alerts: dexterm telegram setup)';

function num(v: string | true | undefined, dflt: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Test seams: the panic switch (default ~/.dexterm/trading.panic, the file `dexterm wallet panic` writes), the
 * Telegram connector / secret store (task-1527), and the host a /use switch carries into the next run.
 */
export interface RunCmdOverrides {
  killSwitch?: KillSwitch; telegram?: Pick<TelegramHostOpts, 'connector' | 'store' | 'timers'>; telegramHost?: TelegramHost;
}

export async function runCmd(argv: string[], io: AutotradeIo, over: RunCmdOverrides = {}): Promise<number> {
  // task-1529: `--all` runs every strategy of autotrade.json at once (fleet.ts).
  if (argv.includes('--all')) return (await import('./fleet.ts')).fleetRunCmd(argv, io, { killSwitch: over.killSwitch });
  const { pos, opts } = parseArgs(argv, BOOL);
  if (opts.live || opts['devnet-rehearsal'] !== undefined || opts['signer-size'] !== undefined) { io.stderr.write(`${NO_LIVE}\n`); return 2; }
  if (!opts.paper) { io.stderr.write(`dexterm autotrade run: pass --paper (autotrade runs on paper only)\nusage: ${RUN_USAGE}\n`); return 2; }
  const arg = typeof opts.strategy === 'string' ? opts.strategy : pos[0];
  const r = resolveStrategyArg(arg, io);
  if (!r) { io.stderr.write(`usage: ${RUN_USAGE}\n`); return 2; }
  for (const w of r.warnings) io.stderr.write(`warning ${w.path} ${w.msg}\n`);
  if (!r.ok) { for (const e of r.errors) io.stderr.write(`error ${e.path} ${e.msg}\n`); return 1; }
  const strategy = r.strategy;
  if (strategy.mode !== 'paper') { io.stderr.write(`dexterm autotrade run: ${strategy.id} is mode "${strategy.mode}": the runner runs paper only (dexterm holds no key and places no live order)\n`); return 1; }

  const home = dextermHome(io.env);
  // task-1537: the run's lines and the agents' messages speak the user's basis (--price/--mcap/env, config, market cap)
  const basis = pickBasis(loadConfig(home).config.display?.priceMode, io.env);
  const kill = over.killSwitch ?? new KillSwitch();
  const panic = kill.engaged();
  if (panic) { io.stderr.write(`dexterm autotrade run: the panic switch is engaged (${panic.reason}); nothing starts until you run \`dexterm wallet resume\` in a terminal\n`); return 1; }
  const cfg = loadRunnerConfig(home);
  if (!cfg.ok) { io.stderr.write(`dexterm autotrade run: ${cfg.path} is invalid:\n${cfg.errors.map((e) => `  ${e}`).join('\n')}\n`); return 1; }
  const config = cfg.config;
  const replay = typeof opts.replay === 'string' ? opts.replay : null;
  // task-1543: the engine for the sessions: --engine, else ai.json (surfaces.autotrade / provider); auto = claude.
  let local: Awaited<ReturnType<typeof localEngine>> | null = null;
  if (!opts.stub) {
    const r = await localEngine(opts, io);
    if ('error' in r) { io.stderr.write(`dexterm autotrade run: ${r.error}\n`); return r.code; }
    local = r.engine === 'ollama' ? r : null;
  }
  const quiet = !!opts.quiet;
  const say = (s: string) => { if (!quiet) io.stdout.write(`${s}\n`); };

  const runId = newRunId(strategy.id);
  const lock = acquireRunLock(home, runId);
  if (!lock.ok) { io.stderr.write(`dexterm autotrade run: another runner is active (pid ${lock.holder.pid}, run ${lock.holder.runId}); stop it first\n`); return 1; }
  if (lock.reclaimed) say(`reclaimed a stale runner lock (pid ${lock.reclaimed.pid} is gone)`);
  if (!clearStaleControl(home, runId)) { io.stderr.write(`dexterm autotrade run: ${controlPath(home)} cannot be read; look at it and remove it, then start again\n`); releaseRunLock(home, runId); return 1; }

  const badge = 'PAPER';
  // Telegram: the user's own bot, when it is set up and paired (or the host a /use switch carried over).
  let host: TelegramHost | null = over.telegramHost ?? null;
  const ownHost = !over.telegramHost;
  let liveData: { tokens(m: string[]): Promise<Map<string, { pair: { priceUsd: number | null; priceNative: number | null; quoteMint: string } }>> } | null = null;
  // The card's SOL/USD: the coin's own SOL-quoted pair on DexScreener at the close (live data only; a replay sends text).
  const solUsdFor = async (mint: string): Promise<number | null> => {
    const v = liveData ? (await liveData.tokens([mint])).get(mint) : undefined;
    const p = v?.pair;
    return p && p.quoteMint === 'So11111111111111111111111111111111111111112' && p.priceUsd && p.priceNative ? p.priceUsd / p.priceNative : null;
  };
  if (!host && !opts['no-telegram']) {
    const t = await startTelegramHost({ home, exec: simExecutor(strategy.execution), say, ...over.telegram, solUsdFor });
    if (t.ok) host = t.host;
    else if (!t.quiet) say(`telegram: off (${t.why})`);
  }
  if (strategy.entry.decide === 'agent+approve' && !host) {
    io.stderr.write(`dexterm autotrade run: ${strategy.id} needs a one-tap approval for every entry (entry.decide "agent+approve"), and no paired Telegram chat is connected; set it up with \`dexterm telegram setup\`\n`);
    releaseRunLock(home, runId);
    return 1;
  }
  const baseExec = simExecutor(strategy.execution);
  if (host) host.attach(runId, strategy, baseExec, solUsdFor);

  const { ledger, files } = fileLedger(home, runId, host?.onLedger);
  const startedAt = Date.now();
  const gate = new SessionGate(effectiveCaps(strategy, config), config.allowanceGuard);
  let runNow = startedAt;
  const log = (kind: string, data: Record<string, unknown>) => { ledger.add(runNow, kind, data); };
  // The run ledger anchors the chat audit (day file, head, count) at start and end: `dexterm telegram audit --verify`
  // cross-checks these, so a chat audit cut or re-chained after an anchor no longer verifies.
  const anchorChat = (when: 'start' | 'end') => { const h = host?.service.audit.head(); if (h?.file && h.day && h.events > 0) log('chat_audit', { when, day: h.day, file: h.file, head: h.head, events: h.events }); };
  anchorChat('start');
  const rawPath = opts.raw ? join(home, 'autotrade', 'runs', `${runId}.stream.jsonl`) : null;

  let sessions: RunSessionFactory | null;
  if (opts.stub) sessions = stubSession();
  else if (local && local.engine === 'ollama') {
    sessions = ollamaSessionFactory({
      client: local.client, model: local.model, numCtx: local.numCtx, restriction: local.level, live: false,
      systemPrompt: (s) => runnerSystemPrompt(s, { live: !replay, basis }),
      gate, log,
      onRaw: rawPath ? (id, line) => appendFileSync(rawPath, `${JSON.stringify({ sessionId: id, line })}\n`, { mode: 0o600 }) : undefined,
    });
  } else {
    sessions = claudeSessionFactory({
      bin: typeof opts['claude-bin'] === 'string' ? opts['claude-bin'] : (io.env.DEXTERM_CLAUDE_BIN || 'claude'),
      account: () => prepareAccount(config.account, io.env),
      model: typeof opts.model === 'string' ? opts.model : undefined,
      systemPrompt: (s) => runnerSystemPrompt(s, { live: !replay, basis }),
      gate, log,
      onRaw: rawPath ? (id, line) => appendFileSync(rawPath, `${JSON.stringify({ sessionId: id, line })}\n`, { mode: 0o600 }) : undefined,
      now: () => runNow,
    });
  }

  // The market: a paced tape, or the live keyless data layer.
  let source: { name: string; ticks: AsyncIterable<MarketTick>; startT?: number } | undefined;
  let tape: ReturnType<typeof loadTape> | undefined;
  let live: LiveSource | null = null;
  let dossier: DossierFn | undefined;
  let vet: VetFn | undefined;
  let closeData = () => {};
  if (replay) {
    try { tape = loadTape(builtinTapePath(replay)); } catch (e) { io.stderr.write(`dexterm autotrade run: ${(e as Error).message}\n`); releaseRunLock(home, runId); return 1; }
  } else {
    const rpc = resolveRpcUrl({ env: io.env });
    const data = createDataLayer({ dbPath: io.env.DEXTERM_DB_PATH || defaultDbPath(io.env), rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl });
    closeData = () => data.close();
    liveData = data.dexscreener as unknown as typeof liveData;
    live = new LiveSource({ store: data.store, dexscreener: data.dexscreener }, { onLog: (l) => log('source_error', { error: l.slice(0, 300) }) });
    source = { name: 'live keyless data layer (Store + DexScreener tokens/v1 fast lane)', ticks: live.ticks(), startT: startedAt };
    // v1 dossier: the MCP get_dossier assembly (market, holders, security, candles, tape, creator) for the mint.
    const { McpTools } = await import('@dexterm/mcp');
    const mcp = new McpTools(data, () => ({ screen: 'autotrade-runner', actions: { mints: [], feeds: [], sortKeys: [] } }));
    dossier = async (k, h, matched, b) => {
      let rec: Record<string, unknown>;
      try { rec = await mcp.call('get_dossier', { mint: k.mint, interval: '5m' }); } catch (e) { rec = { availability: { present: [], missing: [`dossier: ${(e as Error).message}`], knownUnavailable: [] } }; }
      return renderDossierRecord(rec, { mint: k.mint, symbol: k.symbol, matched }, k, h, b, basis);
    };
    // task-1532: the strategy's LARP gate (entry.safety.larp) on live data, once per coin, before it becomes a candidate.
    const larp = strategy.entry.safety.larp;
    if (larp) vet = larpVet(larp, (mint) => mcp.call('larp_check', { mint }));
  }

  // Heartbeat + rendezvous: on every state change (throttled to 1 s) and every 10 s regardless.
  let last: RunnerState | null = null;
  let lastWrite = 0;
  // Dead-man: the time of the last heartbeat that was written OK; entries pause when it goes stale (a full disk,
  // a removed directory), because the TUI and the monitor would see this runner as dead.
  let lastBeatOk = startedAt;
  let beatFailing = false;
  const writeState = (force = false) => {
    if (!last) return;
    const now = Date.now();
    if (!force && now - lastWrite < 1000) return;
    lastWrite = now;
    const { t: _t, ...body } = last;
    try {
      writeRendezvous(home, { schema: RUNNER_RENDEZVOUS_SCHEMA, pid: process.pid, mode: 'paper', runId, startedAt, heartbeatAt: now, ledgerPath: files.ledger, ...body });
      writeJsonAtomic(files.summary, { schema: RUN_SUMMARY_SCHEMA, runId, strategy: body.strategy, startedAt, updatedAt: now, state: body.state, book: body.book, spend: body.spend, events: body.events, ledgerHead: body.ledgerHead, source: replay ? `replay ${replay}` : 'live' });
      lastBeatOk = now;
      if (beatFailing) { beatFailing = false; log('heartbeat_ok', {}); }
    } catch (e) {
      if (!beatFailing) { beatFailing = true; log('heartbeat_failed', { error: (e as Error).message.slice(0, 200) }); }
    }
  };
  const beat = setInterval(() => writeState(true), HEARTBEAT_MS);

  const maxMin = num(opts['max-minutes'], 0);
  const stopAt = maxMin ? startedAt + maxMin * 60_000 : Infinity;
  let stopping = false;
  const stop = (why: string) => { if (stopping) return; stopping = true; log('stop_requested', { why }); say(`stopping (${why}): open sessions close, the paper book is kept in the ledger`); live?.stop(); };
  const onSig = () => stop('signal');
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  // The heartbeat goes stale only while writes fail (a slow first fetch before any state is not a failure).
  const safety = new RunnerSafety({ home, runId, killSwitch: kill, heartbeatAgeMs: () => (beatFailing ? Date.now() - lastBeatOk : 0) });

  if (strategy.highRisk) say(`⚠ HIGH RISK strategy (${strategy.id}): one position at a time, early entries, most of them lose. Paper only; not financial advice.`);
  say(`dexterm autotrade run · ${badge} · strategy ${strategy.id} v${strategy.version} (${strategy.hash}) · ${replay ? `replay ${replay}` : 'live keyless data'} · sessions ${opts.stub ? 'stub' : local ? `ollama (local ${local.model}, profile ${local.level}, $0)` : `claude (${config.account.kind}${typeof opts.model === 'string' ? `, ${opts.model}` : ''})`}`);
  say(`run ${runId} · ledger ${files.ledger} · rendezvous ${runnerRendezvousPath(home)}`);
  if (host) say(`telegram: on (your own bot, ${badgeOf(host.port.network)}) · approvals ${strategy.entry.decide === 'agent+approve' ? 'required by the strategy' : 'when turned on'} · /status /pause /kill from your paired chat`);
  let switchTo: string | null = null;
  let code = 0;
  try {
    const res = await runAutotrade({
      strategy, basis, tape, source, sessions, gate, dossier, vet, verbose: true, onLine: say, ledger, runId,
      ...(host ? { executor: host.port, approvals: host.service.broker } : { executor: baseExec }),
      pacing: replay ? { mode: 'paced', msPerTick: num(opts['ms-per-tick'], 2000) } : { mode: 'live' },
      // The panic file (`dexterm wallet panic`), a stop / flatten request and a local stop (signal, --max-minutes) all
      // halt: no new entries, sessions close. A signal or --max-minutes also ends the tick stream at once.
      safety: () => {
        if (Date.now() >= stopAt) stop('max-minutes');
        const v = safety.step();
        return stopping && !v.halt ? { ...v, halt: 'runner-stopped', detail: 'a signal or --max-minutes' } : v;
      },
      onState: (st) => { runNow = st.t; last = st; writeState(st.state === 'stopped'); host?.onState(st); },
      onFocus: (marks) => { live?.setFocus(marks); writeFocus(home, marks); },
    });
    const next = host?.takeSwitch() ?? null;
    if (next && !stopping) switchTo = next.id;
    say(`done · ${res.candidates} candidates · ${res.sessions} sessions · $${res.sessionCostUsd.toFixed(4)} model spend · ${res.trades.length} closed, ${res.openAtEnd.length} open · ledger head ${ledger.head()}`);
  } catch (e) {
    io.stderr.write(`dexterm autotrade run: ${(e as Error).message}\n`);
    code = 1;
  } finally {
    clearInterval(beat);
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
    anchorChat('end');
    writeState(true);
    writeFocus(home, []);
    live?.stop();
    closeData();
    clearControl(home, runId);
    releaseRunLock(home, runId);
    if (host && !(switchTo && code === 0) && ownHost) await host.stop();
  }
  if (host && switchTo && code === 0) {
    // A confirmed /use: the same bot, the next run on the new strategy (it was checked equal-or-tighter).
    say(`telegram: starting the next run on ${switchTo}`);
    const rest: string[] = [];
    let dropped = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--strategy') { i++; continue; }
      if (!dropped && argv[i] === arg) { dropped = true; continue; }
      rest.push(argv[i]);
    }
    const c2 = await runCmd([switchTo, ...rest], io, { ...over, telegramHost: host });
    if (ownHost) await host.stop();
    return c2;
  }
  return code;
}

/** Candidate + held coins for the recorder's tick lane (task-1504 focus file); best effort, never fails the run. */
function writeFocus(home: string, marks: { mint: string; role: 'held' | 'candidate' }[]): void {
  void import('@dexterm/recorder').then((m) => {
    try { m.writeFocusFile(m.focusFilePath(home), marks.map((x) => ({ mint: x.mint, role: x.role, until: Date.now() + 30 * 60_000 })), Date.now()); } catch { /* the recorder is optional */ }
  }).catch(() => {});
}

/**
 * task-1543: resolve the session engine. claude = the original path (null here). ollama = the user's local model,
 * allowed only when the local profile allows autotrade (paper) — checked before the run lock.
 */
async function localEngine(opts: Record<string, string | true>, io: AutotradeIo): Promise<{ error: string; code: number } | { engine: 'claude' } | { engine: 'ollama'; client: import('@dexterm/mcp/engine').OllamaClient; model: string; numCtx: number; level: import('@dexterm/mcp/engine').Restriction }> {
  const eng = await import('@dexterm/mcp/engine');
  const loaded = eng.loadAiConfig(io.env);
  const flag = typeof opts.engine === 'string' ? eng.parseEngineChoice(opts.engine) : null;
  if (typeof opts.engine === 'string' && !flag) return { error: `unknown engine ${String(opts.engine).slice(0, 16)} (claude|ollama)`, code: 2 };
  const choice = flag ?? eng.engineChoiceFor('autotrade', loaded.config, io.env);
  if (choice === 'auto' || choice === 'claude') return { engine: 'claude' };
  if (choice === 'codex') return { error: 'autotrade sessions run on claude or a local ollama model (codex has no session mode); pass --engine claude or --engine ollama', code: 2 };
  const set = eng.ollamaSettings(loaded.config, io.env);
  const client = new eng.OllamaClient({ host: set.host });
  let pulled: string[];
  try { pulled = await client.tags(); } catch (e) { return { error: `Ollama is not reachable at ${set.host.url} (${(e as Error).message.slice(0, 120)}); start it, or run on claude (--engine claude)`, code: 1 }; }
  const asked = typeof opts.model === 'string' && eng.MODEL_NAME.test(opts.model) && !/^claude/i.test(opts.model) ? opts.model : null;
  const model = asked ?? set.model ?? eng.pickModel(pulled);
  if (!model) return { error: `no local model pulled: ollama pull ${eng.SUGGESTED_MODELS[0].name} && dexterm ai model ${eng.SUGGESTED_MODELS[0].name}`, code: 1 };
  if (!pulled.includes(model) && !pulled.includes(`${model}:latest`)) return { error: `${model} is not pulled: ollama pull ${model}`, code: 1 };
  const { level, note } = eng.effectiveRestriction(loaded.config, model, io.env);
  if (note) io.stderr.write(`note: ${note}\n`);
  try { assertAutotradeAllowed(level, false); } catch (e) { return { error: (e as Error).message, code: 1 }; }
  const w = eng.remoteHostWarning(set.host);
  if (w) io.stderr.write(`warning: ${w}\n`);
  return { engine: 'ollama', client, model, numCtx: Math.min(set.numCtx, 16384), level };
}

/**
 * task-1532: the LARP gate. `larp_check` (the MCP tool: links, website, domain age, repo, X account) scores the coin
 * 0-100; above maxScore is refused. A check that fails, times out (20 s) or comes back without a score is "unknown":
 * refused when the strategy says reject (the default for yolo). Evidence, not a verdict: a low score is not a safety check.
 */
export function larpVet(g: { maxScore: number; unknown: 'reject' | 'allow' }, check: (mint: string) => Promise<Record<string, unknown>>, timeoutMs = 20_000): VetFn {
  return async (k) => {
    let rec: Record<string, unknown> | null = null;
    let why = '';
    // task-1574: the timeout keeps the event loop alive until the race settles (an unref'd timer let a check that never
    // answers leave the vet pending forever when nothing else held the loop; Node 22's test runner cancels on that).
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      rec = await Promise.race([check(k.mint), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs); })]);
      if (rec && typeof rec.error === 'string') { why = rec.error.slice(0, 120); rec = null; }
    } catch (e) { why = (e as Error).message.slice(0, 120); } finally { clearTimeout(timer); }
    const score = rec && typeof rec.score === 'number' && Number.isFinite(rec.score) ? rec.score : null;
    if (score === null) {
      const detail = `the LARP check could not run${why ? ` (${why})` : ''}`;
      return g.unknown === 'allow' ? { ok: true, note: `${detail}; allowed by the strategy` } : { ok: false, rule: 'larp-unknown', detail };
    }
    const band = typeof rec!.band === 'string' ? rec!.band : '';
    if (score > g.maxScore) return { ok: false, rule: 'larp-score', detail: `LARP score ${score}${band ? ` (${band})` : ''} is above ${g.maxScore}` };
    return { ok: true, note: `LARP score ${score}${band ? ` (${band})` : ''} ≤ ${g.maxScore}` };
  };
}
