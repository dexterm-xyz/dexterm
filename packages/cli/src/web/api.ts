// dexterm — the Strategy Builder web UI's API (task-2170). PAPER ONLY. A declarative route table: every route names
// whether it changes state and which existing dexterm tools or functions it reaches, so autotrade-web-2170.test.ts can
// enumerate all of them and assert there is no path to real mode, arming, caps, bankrolls, Claude budgets, signing or
// sending. Nothing here implements strategy logic: reads go through the same AutotradeTools the chat's MCP server runs
// (in-process, actor `web`), changes through the same preview → confirm functions (factory/control.ts) and the same
// proposal files the Q screen applies (applyProposal re-checks everything from scratch).
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import * as engine from '@dexterm/autotrade';
import { applyOps, dextermHome } from '@dexterm/custom';
import { defaultDbPath } from '@dexterm/data';
import { openHistoryReadOnly } from '@dexterm/recorder';
import { AutotradeTools, ProposalFiles, checkProposal, proposalCardView, type Engine } from '@dexterm/mcp';
import type { DatabaseSync } from 'node:sqlite';
import { applyProposal, recheck, keysNeeded } from '../screens/autotrade-proposals.ts';
import { spectatorInfoPath } from '../spectate-cmd.ts';
import { rulesInWords, strategyOverlayView } from '../overlay/strategy.ts';
import { launchWatch, watchCommand, type LaunchResult, type WatchCommand } from './launch.ts';
import type { WebChat } from './chat.ts';

const ENGINE: Engine = { at: engine, applyOps };
export const WEB_ACTOR = 'web';

/** The read tools the web reaches (AutotradeTools, in-process). */
export const WEB_READ_TOOLS = ['strategy_overview', 'strategy_list', 'strategy_get', 'strategy_journey', 'strategy_forward_report', 'strategy_compare_lab', 'factory_status', 'factory_candidates', 'factory_why', 'factory_lessons'] as const;
/** The paper actions the web reaches (AutotradeTools): a proposal file, a recorded-data backtest, a paper forward test. */
export const WEB_ACTION_TOOLS = ['strategy_propose_edit', 'strategy_propose_new', 'strategy_backtest', 'strategy_forward_start', 'strategy_forward_stop'] as const;

export interface WebCtx { body: Record<string, unknown>; query: URLSearchParams; chat: WebChat; chatId: string }
export interface WebRoute { method: 'GET' | 'POST'; path: string; change: boolean; limit?: 'chat' | 'launch' | 'backtest' | 'change'; reaches: readonly string[]; run: (api: WebApi, c: WebCtx) => Promise<unknown> }

export interface WebApiOpts {
  env: NodeJS.ProcessEnv;
  /** Tests: a launcher instead of opening a terminal. */
  launch?: (cmd: WatchCommand) => LaunchResult;
  /** Tests: the tools (stub tape, stub spawners). */
  tools?: AutotradeTools;
  now?: () => number;
}

const ID = engine.STRATEGY_ID;
const str = (x: unknown, max = 200): string => (typeof x === 'string' ? x.slice(0, max) : '');

export class WebApi {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly tools: AutotradeTools;
  readonly launcher: (cmd: WatchCommand) => LaunchResult;
  private db: DatabaseSync | null | undefined;

  constructor(o: WebApiOpts) {
    this.env = o.env;
    this.home = dextermHome(o.env);
    this.launcher = o.launch ?? ((cmd) => launchWatch(cmd, { env: this.env }));
    this.tools = o.tools ?? new AutotradeTools({ actor: WEB_ACTOR, env: o.env, historyDb: () => this.historyDb(), ...(o.now ? { now: o.now } : {}) });
  }

  private historyDb(): DatabaseSync | null {
    if (this.db !== undefined) return this.db;
    const p = this.env.DEXTERM_DB_PATH || defaultDbPath(this.env);
    try { this.db = existsSync(p) ? openHistoryReadOnly(p) : null; } catch { this.db = null; }
    return this.db ?? null;
  }

  store(): engine.StrategyStore { return new engine.StrategyStore({ home: this.home, env: this.env }); }
  /** Every id the store lists now: the only ids a path or body parameter may name. */
  knownIds(): string[] { return this.store().list().map((e) => e.id); }
  knownId(x: unknown): string | null { return typeof x === 'string' && ID.test(x) && this.knownIds().includes(x) ? x : null; }
  tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return this.tools.call(name, args); }

  /** Is a spectator stream live (its discovery file names a port that accepts a connection)? */
  async spectator(): Promise<{ live: boolean; port: number | null }> {
    let port: number | null = null;
    try { const j = JSON.parse(readFileSync(spectatorInfoPath(this.env), 'utf8')) as { port?: unknown }; if (Number.isInteger(j.port)) port = j.port as number; } catch { return { live: false, port: null }; }
    if (port === null) return { live: false, port: null };
    const live = await new Promise<boolean>((resolve) => {
      const s = connect({ host: '127.0.0.1', port: port! });
      const done = (ok: boolean): void => { s.destroy(); resolve(ok); };
      s.setTimeout(400, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false));
    });
    return { live, port: live ? port : null };
  }

  /** The numbers the stats code returns for every strategy: held-out test, factory evidence row, backtest, forward, live paper. */
  async strategies(): Promise<unknown> {
    const ov = await this.tool('strategy_overview');
    const rows = (ov.strategies as Array<Record<string, unknown>> | undefined) ?? [];
    const ids = rows.map((r) => String(r.id));
    const lab: Record<string, unknown> = {};
    for (let i = 0; i < ids.length; i += 12) {
      const r = await this.tool('strategy_compare_lab', { ids: ids.slice(i, i + 12) });
      for (const x of (r.rows as Array<Record<string, unknown>> | undefined) ?? []) lab[String(x.id)] = x;
    }
    const ev = evidenceRows(this.home);
    const files = new ProposalFiles(this.home);
    const pending = files.list({ status: 'pending' });
    const gens = new Map(engine.listGenerated(this.home).map((g) => [g.id, g]));
    return {
      paper: true,
      strategies: rows.map((r) => {
        const id = String(r.id);
        const g = gens.get(id);
        return {
          ...r, numbers: lab[id] ?? null, evidence: ev.rows[id] ?? null,
          generated: g ? { stage: g.stage, parents: g.parents, by: g.source ?? 'factory', summary: g.rationale?.summary ?? null, expectedFailure: g.rationale?.expectedFailure ?? null, retired: g.retired ?? null } : null,
          pendingProposals: pending.filter((p) => p.id === id).map((p) => p.proposalId),
        };
      }),
      evidenceWindow: ev.window,
      note: ov.note ?? null,
    };
  }

  async strategy(id: string): Promise<unknown> {
    const got = this.store().get(id);
    const [doc, journey, forward] = await Promise.all([this.tool('strategy_get', { id }), this.tool('strategy_journey', { id }), this.tool('strategy_forward_report', { id })]);
    const why = engine.loadGenerated(this.home, id) ? await this.tool('factory_why', { id }) : null;
    const pending = new ProposalFiles(this.home).list({ status: 'pending', id }).map(proposalCardView);
    // the builder edits the raw document (the tool's copy frames text fields <untrusted> for a model); the page shows
    // every string as text only
    const raw = this.store().raw(id);
    const source = this.store().list().find((e) => e.id === id)?.source ?? null;
    return { paper: true, id, source, raw, profiles: got && got.ok ? got.strategy.exits.profiles : null, valid: !!got?.ok, words: got && got.ok ? rulesInWords(got.strategy) : null, doc: { hash: doc.hash ?? null, warnings: doc.warnings ?? [], readOnly: doc.readOnly ?? null }, journey, forward: forward.error ? null : forward, why, pending, cook: strategyOverlayView({ home: this.home, store: this.store(), id }) };
  }
}

/** The factory's last evidence table per strategy id (exactly the numbers its analyst was shown), if any. */
function evidenceRows(home: string): { window: unknown; rows: Record<string, Record<string, number | string | null>> } {
  const snap = engine.loadEvidenceSnapshot(home);
  if (!snap) return { window: null, rows: {} };
  const rows: Record<string, Record<string, number | string | null>> = {};
  for (const r of snap.rows) {
    const n = (k: string): number | null => (typeof snap.numbers[`${r.ref}.${k}`] === 'number' ? snap.numbers[`${r.ref}.${k}`] : null);
    rows[r.id] = { ref: r.ref, n: n('n'), meanPct: n('meanPct'), lo: n('lo'), hi: n('hi'), mean2xPct: n('mean2xPct'), noTop3Pct: n('noTop3Pct'), rugRatePct: n('rugRatePct') };
  }
  return { window: { ...snap.window, runId: snap.runId, at: new Date(snap.at).toISOString() }, rows };
}

const webChatTurn = (chatId: string): engine.ChatTurn => ({ chatId, turn: `wu-${randomBytes(4).toString('hex')}`, userText: '', surface: 'web' });

function opsOf(x: unknown): unknown { return Array.isArray(x) ? x.slice(0, 40) : x; }

/** Every route the server answers. Nothing outside this table is reachable (an unknown path is a 404 probe). */
export const WEB_ROUTES: readonly WebRoute[] = [
  { method: 'GET', path: '/api/session', change: false, reaches: ['spectator status', 'factory halt state'], run: async (a) => ({ paper: true, home: '~', spectator: await a.spectator(), halt: engine.factoryHalt(a.home), stopFile: engine.factoryStopped(a.home) }) },
  { method: 'GET', path: '/api/strategies', change: false, reaches: ['strategy_overview', 'strategy_compare_lab', 'factory evidence snapshot', 'proposal files (read)'], run: (a) => a.strategies() },
  { method: 'GET', path: '/api/strategy', change: false, reaches: ['strategy_get', 'strategy_journey', 'strategy_forward_report', 'factory_why', 'strategy overlay view'], run: async (a, c) => { const id = a.knownId(c.query.get('id')); return id ? a.strategy(id) : { error: 'unknown strategy id' }; } },
  { method: 'GET', path: '/api/cook', change: false, reaches: ['strategy overlay view'], run: async (a, c) => { const id = a.knownId(c.query.get('id')); return id ? strategyOverlayView({ home: a.home, store: a.store(), id }) : { error: 'unknown strategy id' }; } },
  { method: 'GET', path: '/api/factory', change: false, reaches: ['factory_status', 'factory_candidates', 'pending agent proposals (read)'], run: async (a) => ({ status: await a.tool('factory_status'), candidates: await a.tool('factory_candidates', { limit: 50 }), waiting: engine.listPending(a.home, engine.AGENT_CHAT_ID).filter((p) => p.status === 'pending'), stopFile: engine.factoryStopped(a.home), agentPause: engine.agentPaused(a.home) }) },
  // the factory_lessons rule (lines from days a generator was not shown stay hidden), as plain text: the tool's copy is
  // framed for a model; the page renders this as text only
  { method: 'GET', path: '/api/factory/lessons', change: false, reaches: ['factory lessons.md (read, factory_lessons cutoff)'], run: async (a) => {
    const snap = engine.loadEvidenceSnapshot(a.home);
    const cfg = engine.loadFactoryConfig(a.home);
    const cutoff = snap?.windowEndMs ?? Date.now() - (cfg.ok ? cfg.config.heldOutDays : engine.DEFAULT_FACTORY_CONFIG.heldOutDays) * 86_400_000;
    return { paper: true, lessons: engine.lessonsForPrompt(engine.readLessons(a.home), cutoff).slice(-20_000), hiddenAfter: new Date(cutoff).toISOString() };
  } },
  { method: 'GET', path: '/api/proposals', change: false, reaches: ['proposal files (read)'], run: async (a) => ({ pending: new ProposalFiles(a.home).list({ status: 'pending' }).map((r) => ({ ...proposalCardView(r), kind: r.kind, actor: r.actor, keysNeeded: keysNeeded(recheck(a.store(), r)) })) }) },
  { method: 'GET', path: '/api/chat/log', change: false, reaches: ['this session\'s chat log'], run: async (_a, c) => ({ events: c.chat.log, busy: c.chat.busy }) },

  { method: 'POST', path: '/api/strategies/check', change: false, reaches: ['checkProposal (dry run, writes nothing)'], run: async (a, c) => {
    const kind = c.body.kind === 'new' ? 'new' : 'edit';
    const r = checkProposal(ENGINE, a.store(), { kind, id: str(c.body.id, 40), from: str(c.body.from, 40), name: c.body.name, ops: opsOf(c.body.ops) });
    return r.ok ? { ok: true, errors: [], warnings: r.validation.warnings, diff: r.diff, riskDelta: r.riskDelta, reasons: r.reasons, after: r.after.hash } : { ok: false, stage: r.stage, errors: r.errors, warnings: r.warnings };
  } },
  { method: 'POST', path: '/api/strategies/propose', change: true, limit: 'change', reaches: ['strategy_propose_edit', 'strategy_propose_new'], run: async (a, c) => {
    const why = str(c.body.why, 200) || 'edited in the web Strategy Builder';
    if (c.body.kind === 'new') return a.tool('strategy_propose_new', { id: str(c.body.id, 40), fromPreset: str(c.body.from, 40), name: str(c.body.name, 80), ops: opsOf(c.body.ops) ?? [], why });
    const id = a.knownId(c.body.id);
    return id ? a.tool('strategy_propose_edit', { id, ops: opsOf(c.body.ops), why }) : { error: 'unknown strategy id' };
  } },
  { method: 'POST', path: '/api/proposals/apply', change: true, limit: 'change', reaches: ['applyProposal (the Q screen\'s apply path; re-checks from scratch)'], run: async (a, c) => {
    const files = new ProposalFiles(a.home);
    const rec = files.get(str(c.body.proposalId, 40));
    if (!rec) return { ok: false, message: 'no such proposal' };
    // the user's clicks stand in for the Q screen's keys: one Apply, and for a LOOSER edit a second, explicit "Apply anyway"
    const keys = c.body.confirm === 'apply-looser' ? ['y', 'y'] : c.body.confirm === 'apply' ? ['y'] : [];
    if (!keys.length) return { ok: false, message: 'not applied: press Apply' };
    return applyProposal(a.store(), files, rec, keys);
  } },
  { method: 'POST', path: '/api/proposals/dismiss', change: true, limit: 'change', reaches: ['proposal files (dismiss)'], run: async (a, c) => {
    const files = new ProposalFiles(a.home);
    const rec = files.get(str(c.body.proposalId, 40));
    if (!rec || rec.status !== 'pending') return { ok: false, message: 'no pending proposal' };
    files.resolve(rec.proposalId, 'dismissed');
    return { ok: true, message: `dismissed ${rec.proposalId}` };
  } },
  { method: 'POST', path: '/api/backtest', change: true, limit: 'backtest', reaches: ['strategy_backtest'], run: async (a, c) => {
    const id = a.knownId(c.body.id);
    if (!id) return { error: 'unknown strategy id' };
    const days = Number.isInteger(c.body.days) && (c.body.days as number) >= 1 && (c.body.days as number) <= 14 ? c.body.days as number : 7;
    return a.tool('strategy_backtest', { id, days });
  } },
  { method: 'POST', path: '/api/forward/start', change: true, limit: 'change', reaches: ['strategy_forward_start'], run: async (a, c) => {
    const id = a.knownId(c.body.id);
    if (!id) return { error: 'unknown strategy id' };
    // the strategy's own paper bankroll: the web never passes bankrollUsd
    const hours = typeof c.body.hours === 'number' && c.body.hours >= 0.25 && c.body.hours <= 72 ? c.body.hours : 24;
    const trades = Number.isInteger(c.body.trades) && (c.body.trades as number) >= 1 && (c.body.trades as number) <= 200 ? c.body.trades as number : undefined;
    return a.tool('strategy_forward_start', { id, hours, ...(trades ? { trades } : {}) });
  } },
  { method: 'POST', path: '/api/forward/stop', change: true, limit: 'change', reaches: ['strategy_forward_stop'], run: async (a, c) => { const id = a.knownId(c.body.id); return id ? a.tool('strategy_forward_stop', { id }) : { error: 'unknown strategy id' }; } },
  { method: 'POST', path: '/api/change/preview', change: true, limit: 'change', reaches: ['previewChange (on, off, retire, factory pause/resume/run; surface web)'], run: async (a, c) => {
    const action = str(c.body.action, 20);
    const target = c.body.id === undefined || c.body.id === null ? null : a.knownId(c.body.id);
    if (c.body.id !== undefined && c.body.id !== null && !target) return { ok: false, why: 'unknown strategy id' };
    const r = engine.previewChange(a.home, a.store(), action, target, { chat: webChatTurn(c.chatId) });
    return r.ok ? { ok: true, code: r.change.code, action: r.change.action, target: r.change.target, preview: r.change.preview } : { ok: false, why: r.why, ...(r.real ? { refused: 'real-mode' } : {}) };
  } },
  { method: 'POST', path: '/api/change/confirm', change: true, limit: 'change', reaches: ['confirmChange (the user\'s Confirm = "confirm <code>")'], run: async (_a, c) => c.chat.confirm(c.body.code) },
  { method: 'POST', path: '/api/change/cancel', change: true, limit: 'change', reaches: ['confirmChange (the user\'s Cancel = "cancel")'], run: async (_a, c) => c.chat.cancel(c.body.code) },
  { method: 'POST', path: '/api/chat/message', change: true, limit: 'chat', reaches: ['runAnalyst (the in-app chat\'s assistant and MCP tools, minus the web deny list)'], run: async (_a, c) => c.chat.send(c.body.text) },
  { method: 'POST', path: '/api/chat/stop', change: true, reaches: ['cancel the running chat turn'], run: async (_a, c) => ({ ok: c.chat.cancelTurn() }) },
  { method: 'POST', path: '/api/watch', change: true, limit: 'launch', reaches: ['launchWatch: the fixed `dexterm autotrade watch <id> --open-overlay`'], run: async (a, c) => {
    const w = watchCommand(c.body.id, { knownIds: a.knownIds(), home: a.env.DEXTERM_HOME?.trim() ? a.home : null });
    if (!w.ok) return { launched: false, why: w.why };
    const sp = await a.spectator();
    const r = a.launcher(w.cmd);
    return { ...r, spectator: sp.live ? 'a spectator session is running: the watch window attaches to it (no second one is started)' : 'no spectator session running: the window follows the strategy\'s paper run ledgers' };
  } },
];

export function findRoute(method: string, path: string): WebRoute | null {
  return WEB_ROUTES.find((r) => r.method === method && r.path === path) ?? null;
}
