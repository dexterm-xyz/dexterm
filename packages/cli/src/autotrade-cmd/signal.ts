// `dexterm autotrade signal …` (task-1645, 0.2.0 card A): real mode and the LIVE TRADE FIRE signal. dexterm holds NO
// key, signs nothing and builds no transaction: in mode real, every trade the strategy decides becomes a signal your
// OWN executor (a Telegram trading bot of your choice, or any script) may act on.
//
//   status      what is armed, the caps, the kill switch, the channels, the outbox, unconfirmed signals, drift
//   channels    set the channels in connectors.json (next to `dexterm telegram setup`): webhook, signal-cmd, jsonl, mcp,
//               the Telegram copy, the TTL
//   secret      the webhook's HMAC secret: generate into a 0600 file for your executor, set from stdin, remove; it is
//               stored in the OS keychain store, never printed, never an argument
//   arm/disarm  arm needs a REAL terminal: the evidence panel, then a typed phrase with a one-time code; journaled.
//               No MCP tool, no model decision and no chat command reaches this code path. task-1679: below the
//               evidence floor (a completed forward test with minForwardTrades closed paper trades + a backtest) or
//               past a missing rung of the ladder, arming refuses unless the user types a separate OVERRIDE phrase
//               first (journaled `evidence-override`). No flag, env var, pipe or proposal can give it.
//   caps        hard caps outside the model; raising one needs the typed phrase, lowering does not
//   kill/unkill the global real-mode kill switch (unkill needs the typed phrase)
//   held        what dexterm counts as held for real (all runs; the open-position cap counts these); `release <mint>`
//               forgets one you closed yourself (typed phrase: it frees room under the cap)
//   test/flush  a `test` signal through every channel; deliver what is pending and send `halted` for a lost run
//   tail        the newest signals and their delivery and receipt state
//   reconcile   read-only: a PUBLIC wallet address's SOL balance and holdings vs the real-mode book

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { dextermHome } from '@dexterm/custom';
import {
  DEFAULT_REAL_CAPS, EXECUTOR_CHANNELS, Outbox, buildTestSignal, capsProblem, capsRaised, channelsFromConfig, codeHash, confirmPhrase, deadManSweep, disarm, driftReport, enabledChannels,
  engageRealKill, evidenceFloor, heldFromSignals, journalReal, journeyView, markRealApplied, renderFloor, hmacStore, loadArmings, loadCaps, loadHoldings, releaseHolding, allOutboxSignals, loadSignalsConfig, newChallenge, paperTwinHash, phraseMatches, readReceipts, realKill, reconcileWallet,
  releaseRealKill, planCaps, saveArming, saveCaps, saveSignalsConfig, argvProblem, webhookUrlProblem, ACCOUNT_ID_RE, type FetchLike, type RealCaps, type ResolvedStrategy, type RpcCall,
  runLockPath, type SignalsConfig, type StrategyStore, type SignalChannel,
  capsOfValues, divergenceLines, divergenceReport, effectiveLimits, emptyLimits, executorHealth, healthLine, limitsHash, limitsLines, limitsSummary, loadLimits, changeLine, planLimitsSave, raises, saveLimits, readRealJournal, type EffectiveLimits, type LimitsDoc, type LimitSet,
} from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs, storeFor } from './strategies.ts';
import { confirmPlan, limitsWizard } from './limits.ts';

export const SIGNAL_USAGE = [
  'dexterm autotrade signal status [--json]',
  'dexterm autotrade signal channels [--webhook URL|off] [--signal-cmd JSON-ARGV|off] [--jsonl PATH|on|off] [--jsonl-signed on|off] [--mcp on|off] [--telegram on|off] [--ttl SEC] [--executor-port N|off] [--json]',
  'dexterm autotrade signal secret generate --out FILE | secret set | secret remove',
  'dexterm autotrade signal arm <id> [--account ID]   (a real terminal: evidence panel + typed phrase)',
  'dexterm autotrade signal disarm <id>',
  'dexterm autotrade signal caps [set [--per-trade-sol X] [--daily-sol Y] [--buys-per-day N] [--max-open N]] [--json]   (four of the limits: dexterm autotrade limits)',
  'dexterm autotrade signal kill [--reason TEXT] | unkill',
  'dexterm autotrade signal held [--json] | release <mint>   (release: a real terminal + typed phrase)',
  'dexterm autotrade signal test [--account ID] [--wait SEC] [--json] | flush | tail [--n 20] [--json]',
  'dexterm autotrade signal reconcile --wallet PUBLIC_ADDRESS [--json]',
].join('\n');

/** Test seams: the typed confirmation, whether this is a real terminal, the network (webhook, RPC), the clock. */
export interface SignalDeps {
  tty?: boolean;
  typed?: (prompt: string) => Promise<string | null>;
  fetch?: FetchLike;
  rpc?: RpcCall;
  now?: () => number;
  code?: () => string;
  /** task-1654: how long `signal test` waits for receipts (ms; tests pass 0) and how it waits. */
  receiptWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const BOOL = ['json'];
const out = (io: AutotradeIo, s: string) => { io.stdout.write(`${s}\n`); };
const err = (io: AutotradeIo, s: string) => { io.stderr.write(`dexterm autotrade signal: ${s}\n`); };

export function isTty(io: AutotradeIo, deps: SignalDeps): boolean { return deps.tty ?? io.stdin?.isTTY === true; }

/** One visible line from the REAL terminal (a pipe is refused before this is reached). */
export async function typedLine(io: AutotradeIo, deps: SignalDeps, prompt: string): Promise<string | null> {
  if (deps.typed) return deps.typed(prompt);
  io.stderr.write(prompt);
  const stdin = io.stdin as unknown as NodeJS.ReadStream | undefined;
  if (!stdin) return null;
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: stdin, terminal: false });
  try { return await new Promise<string | null>((resolve) => { rl.once('line', (l) => resolve(l)); rl.once('close', () => resolve(null)); }); } finally { rl.close(); stdin.pause?.(); }
}

/**
 * The typed confirmation: only on a real terminal (never a pipe, an env var or a flag), with a fresh one-time code a
 * model could not have known. Returns the code (for the journal hash) or null.
 */
export async function confirmTyped(io: AutotradeIo, deps: SignalDeps, action: string, subject: string): Promise<string | null> {
  if (!isTty(io, deps)) { err(io, `${action.toLowerCase()} needs your typed confirmation on a real terminal (a pipe, a flag or an agent cannot give it)`); return null; }
  const code = (deps.code ?? newChallenge)();
  const want = confirmPhrase(action, subject, code);
  const got = await typedLine(io, deps, `type exactly "${want}" to confirm (anything else cancels): `);
  if (!got || !phraseMatches(got, action, subject, code)) { err(io, 'not confirmed; nothing changed'); return null; }
  return code;
}

function channelLines(sc: SignalsConfig, home: string): string[] {
  const hasSecret = (() => { try { return hmacStore(home, sc).get() !== null; } catch { return false; } })();
  return [
    `  webhook   ${sc.webhook.enabled ? `${sc.webhook.url} · HMAC ${hasSecret ? 'on' : 'OFF (dexterm autotrade signal secret generate --out FILE)'}` : 'off'}`,
    `  cmd       ${sc.cmd.enabled ? JSON.stringify(sc.cmd.argv) : 'off'}`,
    `  jsonl     ${sc.jsonl.enabled ? `${sc.jsonl.path ?? 'autotrade/real/signals.jsonl (default)'}${sc.jsonl.signed ? ` · signed lines (HMAC ${hasSecret ? 'on' : 'OFF: no secret yet'})` : ''}` : 'off'}`,
    `  mcp       ${sc.mcp.enabled ? 'on (MCP tool trade_fire_feed reads autotrade/real/mcp-feed.jsonl)' : 'off'}`,
    `  telegram  ${sc.telegram.enabled ? 'copy on (to your paired chat; for you, not for the executor)' : 'copy off'}`,
    `  ttl       ${sc.ttlSec} s (your executor must ignore a signal after it)`,
    `  listener  ${sc.executor.listenPort ? `127.0.0.1:${sc.executor.listenPort} during a real run (POST /heartbeat, /receipt${hasSecret ? ', HMAC required' : ''})` : 'off (executors append to autotrade/real/executor.jsonl and receipts.jsonl)'}`,
  ];
}

const capNum = (v: number, unit: string) => (Number.isFinite(v) ? `${v}${unit}` : `off${unit ? '' : ''}`);
function capsLine(c: RealCaps): string { return `per trade ${capNum(c.perTradeSol, ' SOL')} · per day ${capNum(c.dailySol, ' SOL')} · ${capNum(c.buysPerDay, '')} buys/day · ${capNum(c.maxOpenPositions, '')} open`; }

export async function signalCmd(argv: string[], io: AutotradeIo, deps: SignalDeps = {}): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const home = dextermHome(io.env);
  const now = deps.now ?? Date.now;
  switch (sub) {
    case undefined: case 'help': out(io, SIGNAL_USAGE); return 0;
    case 'status': return statusCmd(rest, io, home, now);
    case 'channels': return channelsCmd(rest, io, home);
    case 'secret': return secretCmd(rest, io, home);
    case 'arm': return armCmd(rest, io, home, deps, now);
    case 'disarm': {
      const id = rest[0];
      if (!id) { err(io, 'usage: dexterm autotrade signal disarm <id>'); return 2; }
      const had = disarm(home, id, 'cli', now());
      const store = storeFor(io);
      const raw = store.raw(id) as { mode?: string } | null;
      if (raw?.mode === 'real') { const r = store.patch(id, [{ op: 'replace', path: '/mode', value: 'paper' }], { actor: 'user:signal-disarm', why: 'real mode disarmed' }); if (!r.ok) { err(io, r.errors.map((e) => e.msg).join('; ')); return 1; } }
      out(io, had || raw?.mode === 'real' ? `disarmed ${id}: it is mode paper again and sends no signal` : `${id} was not armed`);
      return 0;
    }
    case 'caps': return capsCmd(rest, io, home, deps, now);
    case 'kill': {
      const { opts } = parseArgs(rest);
      engageRealKill(home, typeof opts.reason === 'string' ? opts.reason : 'kill', 'cli', now());
      out(io, 'REAL-MODE KILL SWITCH ON: no trade-fire signal goes out, sells included (a running real run halts at its next tick and sends one final "halted"); lift it with dexterm autotrade signal unkill on your own terminal');
      // task-1679 (0.2.0 decision): the kill switch never closes a position; say which ones are still open.
      const held = Object.values(loadHoldings(home).holdings);
      if (held.length) out(io, `REAL POSITIONS STILL OPEN (${held.length}): ${held.map((h) => `${h.symbol} ${h.mint} (${h.strategyId}, account ${h.accountId})`).join(', ')}: these positions are still open: manage them in your executor (dexterm sends no signal for them while the kill switch is on)`);
      return 0;
    }
    case 'unkill': {
      if (!realKill(home)) { out(io, 'the real-mode kill switch is off'); return 0; }
      const code = await confirmTyped(io, deps, 'UNKILL', 'real');
      if (!code) return 1;
      const r = releaseRealKill(home, { confirmed: true, now: now() });
      if (!r.ok) { err(io, r.why); return 1; }
      out(io, 'real-mode kill switch off (journaled); armed strategies can start again');
      return 0;
    }
    case 'held': return heldCmd(rest, io, home);
    case 'release': {
      const mint = rest[0];
      if (!mint) { err(io, 'usage: dexterm autotrade signal release <mint>'); return 2; }
      if (!loadHoldings(home).holdings[mint]) { err(io, `no real holding on ${mint}`); return 1; }
      const code = await confirmTyped(io, deps, 'RELEASE', mint);
      if (!code) return 1;
      const r = releaseHolding(home, mint, { confirmed: true, now: now() });
      if (!r.ok) { err(io, r.why); return 1; }
      out(io, `released ${r.holding.symbol} (${mint}) from the real holdings (journaled): dexterm no longer counts it or sends its exits`);
      return 0;
    }
    case 'test': case 'flush': return deliverCmd(sub, rest, io, home, deps, now);
    case 'tail': return tailCmd(rest, io, home, now);
    case 'reconcile': return reconcileCmd(rest, io, home, deps);
    default: err(io, `unknown subcommand ${JSON.stringify(sub)}\n${SIGNAL_USAGE}`); return 2;
  }
}

function readOutbox(home: string): Outbox { return Outbox.open(home, { channels: [], noLock: true }); }

function statusCmd(argv: string[], io: AutotradeIo, home: string, now: () => number): number {
  const { opts } = parseArgs(argv, BOOL);
  const sc = loadSignalsConfig(home);
  const caps = loadCaps(home);
  const ob = readOutbox(home);
  const rec = readReceipts(home);
  // task-1654: the limits, the executor's health, the risk state behind the pauses, paper vs real fills.
  const lim = loadLimits(home);
  const gEff = effectiveLimits(lim.ok ? lim.doc : null, { strategyId: '-', accountId: '-', mode: 'real' });
  const exec = executorHealth(home, { now: now(), windowMin: gEff.values.executorSilenceMin ?? null, signal: (n) => ob.get(n), receipts: rec.receipts });
  const div = divergenceReport(ob.signals(), rec.receipts);
  const d = driftReport(ob.signals(), rec.receipts, now());
  const armed = Object.values(loadArmings(home));
  const held = Object.values(loadHoldings(home).holdings);
  // The run that is going right now (its runner holds the run lock) is open, not lost.
  const liveRun = (() => {
    try {
      const l = JSON.parse(readFileSync(runLockPath(home), 'utf8')) as { pid?: number; runId?: string };
      if (typeof l.pid !== 'number' || typeof l.runId !== 'string') return null;
      try { process.kill(l.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return null; }
      return l.runId;
    } catch { return null; }
  })();
  const view = {
    armed: armed.map((a) => ({ id: a.strategyId, version: a.version, hash: a.strategyHash, accountId: a.accountId, armedAt: new Date(a.armedAt).toISOString() })),
    caps: caps.ok ? caps.caps : null, capsProblem: caps.ok ? null : caps.why, kill: realKill(home), channels: enabledChannels(sc.config), problems: sc.problems,
    outbox: { depth: ob.depth(), lastNonce: ob.lastNonceIssued, unclosedRuns: ob.unclosedRuns().map((r) => r.runId).filter((id) => id !== liveRun), corrupt: ob.corrupt, running: liveRun },
    receipts: { total: rec.receipts.length, invalid: rec.invalid, orphan: d.orphanReceipts }, drift: { counts: d.counts, unconfirmed: d.unconfirmed, sizeDrift: d.sizeDrift },
    held: held.map((h) => ({ mint: h.mint, symbol: h.symbol, strategyId: h.strategyId, accountId: h.accountId, nonce: h.nonce, costUsd: Math.round(h.costUsd * 100) / 100 })),
    limits: { ok: lim.ok, problem: lim.ok ? null : lim.why, unjournaled: lim.ok ? lim.unjournaled : null, effective: gEff.values, from: gEff.from },
    executor: exec,
    divergence: { ...div, rows: undefined },
  };
  if (opts.json) { out(io, JSON.stringify(view, null, 2)); return 0; }
  out(io, 'real mode · LIVE TRADE FIRE signals to YOUR executor · dexterm holds no key and signs nothing · experimental, not financial advice');
  out(io, `  armed     ${armed.length ? armed.map((a) => `${a.strategyId} v${a.version} (${a.strategyHash.slice(0, 8)}) account ${a.accountId}`).join('; ') : 'nothing (dexterm autotrade signal arm <id>, on your own terminal)'}`);
  out(io, `  caps      ${caps.ok ? capsLine(caps.caps) : caps.why}`);
  out(io, `  limits    ${lim.ok ? `${limitsSummary(gEff.values)}${lim.unjournaled ? ' · limits.json changed outside dexterm: dexterm autotrade limits diff' : ''}` : lim.why} (dexterm autotrade limits show)`);
  out(io, `  executor  ${healthLine(exec)}`);
  out(io, `  kill      ${view.kill ? `ON (${view.kill.reason})` : 'off'}`);
  for (const l of channelLines(sc.config, home)) out(io, l);
  for (const p of sc.problems) out(io, `  OFF       ${p}`);
  out(io, `  outbox    ${view.outbox.depth} pending · last nonce ${view.outbox.lastNonce}${liveRun ? ` · run ${liveRun} is running` : ''}${view.outbox.unclosedRuns.length ? ` · ${view.outbox.unclosedRuns.length} run(s) ended without "halted" (dexterm autotrade signal flush)` : ''}`);
  out(io, `  held      ${held.length ? `${held.length} of ${caps.ok ? caps.caps.maxOpenPositions : '?'} open: ${held.map((h) => `${h.symbol} (${h.strategyId})`).join(', ')}; the next real run of each strategy keeps its exits` : 'nothing'}`);
  if (div.receipted) out(io, `  fills     ${divergenceLines(div)[1]?.trim() ?? divergenceLines(div)[0]}`);
  out(io, `  receipts  ${rec.receipts.length} · executed ${d.counts.executed} · rejected ${d.counts.rejected} · failed ${d.counts.failed} · unconfirmed ${d.unconfirmed}${d.sizeDrift ? ` · size drift on ${d.sizeDrift}` : ''}${d.orphanReceipts ? ` · ${d.orphanReceipts} orphan` : ''}${rec.invalid ? ` · ${rec.invalid} invalid lines` : ''}`);
  return 0;
}

function channelsCmd(argv: string[], io: AutotradeIo, home: string): number {
  const { opts } = parseArgs(argv, BOOL);
  const cur = loadSignalsConfig(home).config;
  const next: SignalsConfig = structuredClone(cur);
  const onOff = (v: string | true | undefined, name: string): boolean | null => (v === 'on' ? true : v === 'off' ? false : (err(io, `--${name} on|off`), null));
  if (opts.webhook !== undefined) {
    if (opts.webhook === 'off') next.webhook.enabled = false;
    else { const u = String(opts.webhook); const p = webhookUrlProblem(u); if (p) { err(io, `--webhook: ${p}`); return 2; } next.webhook = { ...next.webhook, enabled: true, url: u }; }
  }
  if (opts['signal-cmd'] !== undefined) {
    if (opts['signal-cmd'] === 'off') next.cmd.enabled = false;
    else {
      let argvJ: unknown;
      try { argvJ = JSON.parse(String(opts['signal-cmd'])); } catch { argvJ = String(opts['signal-cmd']).startsWith('/') && !/\s/.test(String(opts['signal-cmd'])) ? [String(opts['signal-cmd'])] : null; }
      const p = argvProblem(argvJ);
      if (p) { err(io, `--signal-cmd: ${p} (a JSON array like '["/usr/local/bin/my-executor","--fast"]'; there is no shell)`); return 2; }
      next.cmd = { enabled: true, argv: argvJ as string[] };
    }
  }
  if (opts.jsonl !== undefined) {
    if (opts.jsonl === 'off') next.jsonl.enabled = false;
    else if (opts.jsonl === 'on' || opts.jsonl === true) next.jsonl.enabled = true;
    else { const p = String(opts.jsonl); if (!p.startsWith('/')) { err(io, '--jsonl: an absolute path, on, or off'); return 2; } next.jsonl = { ...next.jsonl, enabled: true, path: p }; }
  }
  if (opts['jsonl-signed'] !== undefined) { const v = onOff(opts['jsonl-signed'], 'jsonl-signed'); if (v === null) return 2; next.jsonl.signed = v; }
  if (opts['executor-port'] !== undefined) {
    if (opts['executor-port'] === 'off') next.executor.listenPort = null;
    else { const n = Number(opts['executor-port']); if (!Number.isInteger(n) || n < 1024 || n > 65535) { err(io, '--executor-port: 1024 to 65535, or off'); return 2; } next.executor.listenPort = n; }
  }
  if (opts.mcp !== undefined) { const v = onOff(opts.mcp, 'mcp'); if (v === null) return 2; next.mcp.enabled = v; }
  if (opts.telegram !== undefined) { const v = onOff(opts.telegram, 'telegram'); if (v === null) return 2; next.telegram.enabled = v; }
  if (opts.ttl !== undefined) { const n = Number(opts.ttl); if (!Number.isFinite(n)) { err(io, '--ttl: seconds (10 to 600)'); return 2; } next.ttlSec = Math.min(600, Math.max(10, Math.round(n))); }
  const changed = JSON.stringify(next) !== JSON.stringify(cur);
  if (changed) {
    try { saveSignalsConfig(home, next); } catch (e) { err(io, (e as Error).message); return 1; }
  }
  if (opts.json) { out(io, JSON.stringify({ changed, channels: enabledChannels(next), config: next }, null, 2)); return 0; }
  out(io, `${changed ? 'saved' : 'unchanged'} · trade-fire channels (connectors.json, next to your Telegram setup):`);
  for (const l of channelLines(next, home)) out(io, l);
  if (!enabledChannels(next).some((c) => EXECUTOR_CHANNELS.includes(c))) out(io, '  note: real mode needs at least one channel your executor can read (webhook, signal-cmd, jsonl or mcp); a bot cannot read another bot\'s Telegram messages');
  return 0;
}

function secretCmd(argv: string[], io: AutotradeIo, home: string): number | Promise<number> {
  const sc = loadSignalsConfig(home).config;
  const store = hmacStore(home, sc, io.env);
  if (argv[0] === 'remove') { store.remove(); out(io, 'webhook HMAC secret removed (the webhook goes out unsigned until you set a new one)'); return 0; }
  const save = (v: string) => {
    store.set(v);
    try { saveSignalsConfig(home, { ...sc, webhook: { ...sc.webhook, secretStore: store.kind === 'memory' ? null : store.kind } }); } catch { /* the store kind is re-detected next time */ }
  };
  if (argv[0] === 'generate') {
    const { opts } = parseArgs(argv.slice(1));
    if (typeof opts.out !== 'string' || !isAbsolute(opts.out)) { err(io, 'secret generate --out /absolute/file (0600; your executor reads it there; the secret is never printed)'); return 2; }
    const v = randomBytes(32).toString('base64url');
    try { writeFileSync(opts.out, `${v}\n`, { mode: 0o600, flag: 'wx' }); } catch (e) { err(io, `cannot create ${opts.out}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message} (it must not exist yet)`); return 1; }
    save(v);
    out(io, `webhook HMAC secret generated: stored in ${store.kind}, and written to ${opts.out} (0600) for your executor; it is not printed`);
    return 0;
  }
  if (argv[0] === 'set') {
    return (async () => {
      const stdin = io.stdin as unknown as NodeJS.ReadStream | undefined;
      if (!stdin || stdin.isTTY) { err(io, 'secret set reads the secret from a pipe (never an argument): dexterm autotrade signal secret set < FILE'); return 2; }
      let buf = '';
      stdin.setEncoding('utf8');
      for await (const c of stdin) buf += c;
      const v = buf.trim();
      if (!/^[A-Za-z0-9:_-]{16,128}$/.test(v)) { err(io, 'the secret is 16 to 128 characters of A-Z a-z 0-9 : _ -'); return 2; }
      save(v);
      out(io, `webhook HMAC secret stored in ${store.kind}; it is never printed`);
      return 0;
    })();
  }
  err(io, 'secret generate --out FILE | secret set | secret remove');
  return 2;
}

/** The latest backtest of a strategy (its paper twin hash) and a forward-test report, if any, as panel lines. */
function evidence(store: StrategyStore, s: ResolvedStrategy, home: string, before?: ResolvedStrategy): string[] {
  // The paper version being armed (before the mode switch and its version bump), then the real version's paper twin.
  const all = store.backtests();
  const bt = (before ? all[before.hash] : undefined) ?? all[paperTwinHash(s)] ?? all[s.hash];
  const lines: string[] = [bt
    ? `  backtest  ${bt.trades} trades · net ${bt.netPct >= 0 ? '+' : ''}${bt.netPct}% · max drawdown ${bt.maxDrawdownPct}% · ${bt.tape} · ${new Date(bt.t).toISOString().slice(0, 10)} (paper replay, modelled fills)`
    : `  backtest  NONE on record for this version: run dexterm autotrade backtest ${s.id} first`];
  const fwd = forwardReport(home, s.id);
  lines.push(fwd ? `  forward   ${fwd}` : '  forward   no forward-test report on record');
  // task-1647: the journey (evidence on these exact rules) and whether arming now skips a rung of the ladder.
  const view = journeyView(home, s, { armedHash: null });
  if (view.backtest) lines.push(`  held-out  ${view.backtest.verdict}`);
  lines.push(`  journey   stage ${view.stage} (rules ${view.rulesHash.slice(0, 8)})${skipsLadder(home, s) ? ` · SKIPS THE LADDER: ${skipsLadder(home, s)} is missing (dexterm autotrade journey ${s.id})` : ''}`);
  // task-1654: how optimistic paper fills were, from the receipts so far (all real strategies on this machine).
  const dv = divergenceReport(allOutboxSignals(home), readReceipts(home).receipts);
  if (dv.executed) lines.push(`  fills     paper vs real over ${dv.executed} executed fill(s): slippage median ${dv.slippage.medianPct ?? '?'}% · ${dv.partial} partial · ${dv.rejected} rejected (${dv.note})`);
  return lines;
}

/** The missing rung when arming `s` now would skip the ladder (it is below always-on), or null. */
function skipsLadder(home: string, s: ResolvedStrategy): string | null {
  const view = journeyView(home, s, { armedHash: null });
  return view.stage === 'always-on' ? null : view.next?.stage ?? '?';
}

/** A forward-test summary line from autotrade/forward/<id>.json (written by the forward-test runner), if present. */
function forwardReport(home: string, id: string): string | null {
  try {
    const d = JSON.parse(readFileSync(join(home, 'autotrade', 'forward', `${id}.json`), 'utf8')) as { summary?: unknown; trades?: unknown; netPct?: unknown; days?: unknown };
    if (typeof d.summary === 'string') return d.summary.replace(/[^\x20-\x7e]/g, '').slice(0, 160);
    if (typeof d.trades === 'number') return `${d.trades} trades · net ${Number(d.netPct ?? 0)}%${typeof d.days === 'number' ? ` over ${d.days} days` : ''} (paper, live data)`;
  } catch { /* none */ }
  return null;
}

async function armCmd(argv: string[], io: AutotradeIo, home: string, deps: SignalDeps, now: () => number): Promise<number> {
  const { pos, opts } = parseArgs(argv);
  const id = pos[0];
  if (!id) { err(io, 'usage: dexterm autotrade signal arm <id> [--account ID]'); return 2; }
  if (!isTty(io, deps)) { err(io, 'arming real mode needs your typed confirmation on a real terminal (a pipe, a flag, an agent or MCP cannot give it)'); return 2; }
  const accountId = typeof opts.account === 'string' ? opts.account : 'main';
  if (!ACCOUNT_ID_RE.test(accountId)) { err(io, '--account: lowercase letters, digits, - and _ (32 max)'); return 2; }
  const store = storeFor(io);
  const got = store.get(id);
  if (!got) { err(io, `no strategy ${JSON.stringify(id)}`); return 1; }
  if (got.source === 'preset') { err(io, `${id} is a shipped preset: copy it first (dexterm autotrade new my-${id} --from ${id}), then arm the copy`); return 1; }
  if (!got.ok) { err(io, `${id} does not validate: ${got.errors.map((e) => `${e.path} ${e.msg}`).join('; ')}`); return 1; }
  if (got.strategy.mode === 'live') { err(io, `${id} is mode "live" (the removed signer): set it to paper first`); return 1; }
  // What it will be once armed: the same document in mode real, as a new patch version (its hash binds the arming).
  const rawDoc = store.raw(id) as unknown as Record<string, unknown>;
  const already = got.strategy.mode === 'real';
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(rawDoc.version));
  const nextVersion = already || !m ? String(rawDoc.version) : `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  const { validateStrategy } = await import('@dexterm/autotrade');
  const v = validateStrategy({ ...rawDoc, mode: 'real', version: nextVersion });
  if (!v.ok) { err(io, v.errors.map((e) => e.msg).join('; ')); return 1; }
  const s = v.strategy;
  const sc = loadSignalsConfig(home);
  const chans = enabledChannels(sc.config);
  if (!chans.some((c) => EXECUTOR_CHANNELS.includes(c))) { err(io, 'set up a channel your executor can read first (dexterm autotrade signal channels --webhook URL | --signal-cmd JSON | --jsonl on | --mcp on)'); return 1; }
  const k = realKill(home);
  if (k) { err(io, `the real-mode kill switch is on (${k.reason}): dexterm autotrade signal unkill first`); return 1; }
  // task-1654: no silent defaults. No limits saved yet: the wizard asks for YOUR numbers first. Either way the panel
  // shows the effective limits for this strategy + account, and the typed phrase confirms them.
  const lim = loadLimits(home);
  let doc: LimitsDoc;
  let saveDoc = false;
  if (!lim.ok && lim.missing) {
    const g: LimitSet | null = await limitsWizard(io, deps);
    if (!g) { err(io, 'not armed: real mode needs your own limits first (nothing saved)'); return 1; }
    doc = { ...emptyLimits(), global: g };
    saveDoc = true;
  } else if (!lim.ok) { err(io, `${lim.why}; fix the limits first (dexterm autotrade limits show)`); return 1; }
  else {
    if (lim.unjournaled && raises(lim.unjournaled).length) { err(io, 'limits.json was changed outside dexterm and raises limits: dexterm autotrade limits diff, then limits accept, first'); return 1; }
    doc = lim.doc;
    saveDoc = lim.source === 'migrated';
  }
  const eff: EffectiveLimits = effectiveLimits(doc, { strategyId: s.id, accountId, mode: 'real' });
  const caps = capsOfValues(eff.values);
  out(io, `REAL MODE · arm ${s.id} v${s.version} (${s.hash.slice(0, 8)}) · account ${accountId}`);
  out(io, '  every buy and sell this strategy decides becomes a LIVE TRADE FIRE signal for YOUR executor, which may spend real money.');
  out(io, '  dexterm holds no key and signs nothing; the same clamps, exits and ledger as paper. Experimental; not financial advice.');
  for (const l of evidence(store, s, home, got.strategy)) out(io, l);
  out(io, `  caps      ${capsLine(caps)} · hard, outside the model; any edit to the strategy disarms it`);
  out(io, `  limits    in force for ${s.id} on account ${accountId} (the stricter scope wins; the defaults are placeholders, your numbers win):`);
  for (const l of limitsLines(eff)) out(io, `    ${l}`);
  const ex = executorHealth(home, { now: now(), windowMin: eff.values.executorSilenceMin ?? null });
  out(io, `  executor  ${ex.lastSeenAt ? healthLine(ex) : 'never heard from: start your executor (examples/executor in the app) and run dexterm autotrade signal test first'}`);
  for (const l of channelLines(sc.config, home)) out(io, l);
  // task-1679 (0.2.0 decision): the evidence floor (the user's minForwardTrades for this strategy + account) and the ladder.
  // Below either, the arming refuses unless the user types a separate OVERRIDE phrase now; it is journaled.
  const floor = evidenceFloor(home, s, eff.values.minForwardTrades ?? 0);
  for (const l of renderFloor(floor)) out(io, l);
  const skipped = skipsLadder(home, s);
  let override: NonNullable<Parameters<typeof saveArming>[1]['override']> | undefined;
  if (!floor.ok || skipped) {
    out(io, `  REFUSED unless you override: ${[skipped ? `arming now SKIPS THE LADDER (${skipped} is missing)` : '', floor.ok ? '' : 'the evidence floor is not met'].filter(Boolean).join(' and ')}.`);
    out(io, '  Arming without that evidence is your call alone: type the OVERRIDE phrase to go on (it is journaled), anything else cancels.');
    const oc = await confirmTyped(io, deps, 'OVERRIDE', s.id);
    if (!oc) { err(io, `not armed: do the missing step first (dexterm autotrade journey ${s.id})`); return 1; }
    override = { skipsLadder: skipped, floor: floor.problems, minTrades: floor.minTrades, codeHash: codeHash(oc) };
    journalReal(home, { t: now(), action: 'evidence-override', by: 'local-terminal', data: { strategyId: s.id, strategyHash: s.hash, version: s.version, accountId, ...override } });
    out(io, '  override typed (journaled); now the arming phrase.');
  }
  // task-1654 r2 (verify F1): the wizard's save is planned against dexterm's last journaled save (a deleted file's
  // journal still counts), and every raise it makes is listed here, so the phrase confirms exactly what is saved.
  const plan = saveDoc ? planLimitsSave(home, doc) : null;
  if (plan?.before && plan.raised.length) { out(io, '  saving these RAISES limits against dexterm\'s last saved limits:'); for (const c of plan.changes.filter((x) => x.kind === 'raise')) out(io, `    ${changeLine(c)}`); }
  out(io, '  typing the phrase confirms these limits and arms the strategy.');
  const code = await confirmTyped(io, deps, 'REAL', s.id);
  if (!code) return 1;
  if (plan) { const r = saveLimits(home, doc, { confirmed: plan.raised, baseline: plan.baseline, now: now() }); if (!r.ok) { err(io, r.why); return 1; } }
  if (!already) {
    const r = store.patch(id, [{ op: 'replace', path: '/mode', value: 'real' }, { op: 'replace', path: '/version', value: nextVersion }], { actor: 'user:signal-arm', why: 'real mode armed on the local terminal' });
    if (!r.ok) { err(io, r.errors.map((e) => e.msg).join('; ')); return 1; }
    if (r.strategy.hash !== s.hash) { err(io, 'the strategy changed while arming; nothing armed'); return 1; }
  }
  saveArming(home, { strategyId: s.id, strategyHash: s.hash, version: s.version, accountId, armedAt: now(), caps, limits: eff.values, limitsHash: limitsHash(doc), channels: chans, evidence: [...evidence(store, s, home, got.strategy), ...renderFloor(floor)].map((l) => l.trim()), confirmation: { method: 'typed-tty', codeHash: codeHash(code) }, ...(override ? { override } : {}) });
  const promoted = markRealApplied(home, s.id, s.hash, s.version, 'user:signal-arm', now());
  if (promoted.length) out(io, `promotion ${promoted.join(', ')} → real: applied by this arming (journaled)`);
  out(io, `armed ${s.id} for real mode (journaled). Start it with: dexterm autotrade run ${s.id} --real`);
  return 0;
}

async function capsCmd(argv: string[], io: AutotradeIo, home: string, deps: SignalDeps, now: () => number): Promise<number> {
  const { pos, opts } = parseArgs(argv, BOOL);
  const cur = loadCaps(home);
  if (pos[0] !== 'set') {
    if (opts.json) { out(io, JSON.stringify(cur.ok ? cur.caps : { error: cur.why })); return 0; }
    out(io, cur.ok ? `real-mode caps · ${capsLine(cur.caps)}` : cur.why);
    return 0;
  }
  const base = cur.ok ? cur.caps : DEFAULT_REAL_CAPS;
  const n = (k: string, d: number) => (opts[k] === undefined ? d : Number(opts[k]));
  const next: RealCaps = { perTradeSol: n('per-trade-sol', base.perTradeSol), dailySol: n('daily-sol', base.dailySol), buysPerDay: n('buys-per-day', base.buysPerDay), maxOpenPositions: n('max-open', base.maxOpenPositions) };
  const p = capsProblem(next);
  if (p) { err(io, p); return 2; }
  // task-1654 r3 (verify F2): the caps save is planned like any limits save (from dexterm's last journaled save), so
  // a hand edit of limits.json that raises anything, in any scope, is listed here and the phrase covers every line.
  const plan = planCaps(home, next);
  if ('error' in plan) { err(io, plan.error); return 2; }
  const raised = capsRaised(cur.ok ? cur.caps : null, next);
  if (raised.length) out(io, `raising ${raised.join(', ')}: ${capsLine(next)} (was ${cur.ok ? capsLine(cur.caps) : 'not set'})`);
  const l = loadLimits(home);
  let confirmed: string[] = [];
  if (plan.raised.length) {
    const c = await confirmPlan(io, deps, plan, l.ok ? l.unjournaled : null, 'caps');
    if (!c) return 1;
    confirmed = c;
  }
  const r = saveCaps(home, next, { confirmed, baseline: plan.baseline, now: now() });
  if (!r.ok) { err(io, r.why); return 1; }
  out(io, `real-mode caps saved (journaled) · ${capsLine(next)}`);
  return 0;
}

async function deliverCmd(sub: 'test' | 'flush', argv: string[], io: AutotradeIo, home: string, deps: SignalDeps, now: () => number): Promise<number> {
  const { opts } = parseArgs(argv, BOOL);
  const sc = loadSignalsConfig(home).config;
  const built = channelsFromConfig(home, sc, { fetch: deps.fetch, env: io.env, now });
  // task-1654: `signal test` times each channel's delivery of the test signal and then waits for receipts.
  const timing = new Map<string, { ms: number; ok: boolean; why: string | null; duplicate: boolean }>();
  let testNonce = 0;
  const channels: SignalChannel[] = built.channels.map((c) => ({
    name: c.name,
    async deliver(sig, line) {
      const t0 = performance.now();
      const r = await c.deliver(sig, line);
      if (sig.nonce === testNonce) timing.set(c.name, { ms: Math.round(performance.now() - t0), ok: r.ok, why: r.ok ? null : r.why, duplicate: r.ok && !!r.duplicate });
      return r;
    },
  }));
  const defer = built.defer;
  let ob: Outbox;
  try { ob = Outbox.open(home, { channels, defer, now }); } catch (e) { err(io, (e as Error).message); return 1; }
  try {
    const swept = deadManSweep(ob, now());
    if (swept.length) out(io, `sent "halted" (runner-lost) for ${swept.length} run(s) that ended without one`);
    if (sub === 'test') {
      const armed = Object.values(loadArmings(home));
      const accountId = typeof opts.account === 'string' ? opts.account : armed[0]?.accountId ?? 'main';
      if (!ACCOUNT_ID_RE.test(accountId)) { err(io, '--account: lowercase letters, digits, - and _'); return 2; }
      testNonce = ob.allocateNonce();
      ob.enqueue(buildTestSignal({ nonce: testNonce, now: now(), ttlSec: sc.ttlSec, runId: 'signal-test', accountId, strategy: { id: 'signal-test', version: '0.0.0', hash: '0'.repeat(16) } }));
    }
    const r = await ob.pump();
    if (sub === 'flush') {
      out(io, `flushed · acked ${r.acked} · retry later ${r.retried} · rejected ${r.rejected} · expired ${r.expired}${defer.length ? ' · the Telegram copy waits for the next run' : ''}`);
      for (const h of ob.channelHealth()) if (h.lastErr) out(io, `  ${h.name}: ${h.lastErr}`);
      return r.rejected || r.retried ? 1 : 0;
    }
    // Receipts for the test nonce (any status: the round trip works), up to --wait seconds (default 3).
    const waitMs = deps.receiptWaitMs ?? Math.max(0, Math.min(60, Number(opts.wait ?? 3) || 0)) * 1000;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const t0 = now();
    let rx = readReceipts(home).receipts.filter((x) => x.nonce === testNonce);
    while (!rx.length && now() - t0 < waitMs) { await sleep(250); rx = readReceipts(home).receipts.filter((x) => x.nonce === testNonce); }
    const sent = ob.get(testNonce)!;
    const rows = [...enabledChannels(sc)].map((name) => {
      const t = timing.get(name);
      const state = defer.includes(name) ? 'deferred (sent with the next real run)' : t ? (t.ok ? (t.duplicate ? 'acked (duplicate)' : 'acked') : `failed: ${t.why}`) : 'not attempted (an older signal is still pending on this channel: dexterm autotrade signal flush)';
      return { channel: name, executorReadable: EXECUTOR_CHANNELS.includes(name), delivered: !!t?.ok, state, latencyMs: t?.ms ?? null };
    });
    const receipts = rx.map((x) => ({ status: x.status, executor: x.executor, reason: x.reason, afterMs: Math.max(0, x.at - sent.issuedAt) }));
    if (opts.json) { out(io, JSON.stringify({ test: true, nonce: testNonce, id: sent.id, accountId: sent.accountId, channels: rows, receipts, waitedMs: now() - t0 }, null, 2)); }
    else {
      out(io, `TEST signal #${testNonce} (test:true, no mint: nothing tradable) · account ${sent.accountId}`);
      for (const row of rows) out(io, `  ${row.channel.padEnd(9)} ${row.state}${row.latencyMs !== null ? ` · ${row.latencyMs} ms` : ''}${row.executorReadable ? '' : ' · for you, not the executor'}`);
      if (receipts.length) for (const x of receipts) out(io, `  receipt   ${x.status}${x.executor ? ` from ${x.executor}` : ''}${x.reason ? ` (${x.reason})` : ''} · ${Math.round(x.afterMs / 100) / 10} s after the signal`);
      else out(io, `  receipt   none within ${Math.round(waitMs / 1000)} s (the reference kit writes one for a test signal; yours may not, which is fine)`);
    }
    const execRows = rows.filter((x) => x.executorReadable);
    return execRows.length && execRows.every((x) => x.delivered) ? 0 : 1;
  } finally { ob.close(); }
}

function tailCmd(argv: string[], io: AutotradeIo, home: string, now: () => number): number {
  const { opts } = parseArgs(argv, BOOL);
  const n = Math.max(1, Math.min(200, Number(opts.n) || 20));
  const ob = readOutbox(home);
  const d = driftReport(ob.signals(), readReceipts(home).receipts, now());
  const rows = ob.signals().slice(-n).map((s) => {
    const dr = d.rows.find((r) => r.nonce === s.nonce);
    return { nonce: s.nonce, type: s.type, side: s.type === 'trade' ? s.side : null, symbol: s.type === 'trade' ? s.symbol : null, sizeSol: s.type === 'trade' ? s.sizeSol : null, runId: s.runId, accountId: s.accountId, issuedAt: s.issuedAt, delivery: ob.stateOf(s.nonce), receipt: dr?.state ?? null, sizeDriftPct: dr?.sizeDriftPct ?? null };
  });
  if (opts.json) { out(io, JSON.stringify(rows, null, 2)); return 0; }
  if (!rows.length) { out(io, 'no trade-fire signals yet'); return 0; }
  for (const r of rows) out(io, `#${r.nonce} ${new Date(r.issuedAt).toISOString().slice(11, 19)} ${r.type === 'trade' ? `${r.side!.toUpperCase()} ${r.symbol} ${r.sizeSol} SOL` : r.type.toUpperCase()} · delivery ${r.delivery}${r.receipt ? ` · ${r.receipt}` : ''}${r.sizeDriftPct !== null ? ` · size drift ${r.sizeDriftPct}%` : ''}`);
  return 0;
}

function heldCmd(argv: string[], io: AutotradeIo, home: string): number {
  const { opts } = parseArgs(argv, BOOL);
  const l = loadHoldings(home);
  const rows = Object.values(l.holdings);
  if (opts.json) { out(io, JSON.stringify({ source: l.source, holdings: rows.map((h) => ({ ...h, position: undefined, carried: !!h.position })) }, null, 2)); return 0; }
  if (!rows.length) { out(io, 'no real holdings'); return 0; }
  out(io, `real holdings (${rows.length}; the open-position cap counts all of them${l.source === 'rebuilt' ? '; rebuilt from the outbox' : ''}):`);
  for (const h of rows) out(io, `  ${h.symbol} ${h.mint} · ${h.strategyId} · account ${h.accountId} · cost $${h.costUsd.toFixed(2)} · last signal #${h.nonce}${h.position ? ' · exits resume from the saved view' : ''}`);
  out(io, 'the next real run of the same strategy takes each over and keeps its exits; closed it yourself? dexterm autotrade signal release <mint>');
  return 0;
}

async function reconcileCmd(argv: string[], io: AutotradeIo, home: string, deps: SignalDeps): Promise<number> {
  const { opts } = parseArgs(argv, BOOL);
  if (typeof opts.wallet !== 'string') { err(io, 'reconcile --wallet PUBLIC_ADDRESS (a public address; never a key)'); return 2; }
  // r2: the persisted holdings (all runs; they survive outbox compaction), not just the live outbox's signals.
  const heldMints = Object.keys(loadHoldings(home).holdings);
  const book = { held: heldMints, closed: heldFromSignals(allOutboxSignals(home)).closed.filter((m) => !heldMints.includes(m)) };
  let rpc = deps.rpc;
  if (!rpc) {
    const { resolveRpcUrl } = await import('@dexterm/data');
    const url = resolveRpcUrl({ env: io.env }).url;
    let id = 0;
    rpc = async (method, params) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), redirect: 'error' });
      const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) throw new Error(String(j.error.message ?? 'rpc error').slice(0, 120));
      return j.result;
    };
  }
  let r;
  try { r = await reconcileWallet(opts.wallet, rpc, book); } catch (e) { err(io, (e as Error).message); return 2; }
  if (opts.json) { out(io, JSON.stringify(r, null, 2)); return r.errors.length ? 1 : 0; }
  out(io, `reconcile (read-only) · wallet ${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)} · SOL ${r.sol ?? '?'} · ${Object.keys(r.holdings).length} token holdings`);
  out(io, `  real-mode book holds ${book.held.length} mint(s); missing from the wallet: ${r.missing.length ? r.missing.join(', ') : 'none'}`);
  if (r.stillHeld.length) out(io, `  closed in the book but still in the wallet: ${r.stillHeld.join(', ')}`);
  for (const e of r.errors) out(io, `  could not read: ${e}`);
  return r.errors.length ? 1 : 0;
}
