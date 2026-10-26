// dexterm autotrade — the strategy store (task-1503 AT-1, AUTOTRADE-SPEC §2c).
//
//   ~/.dexterm/strategies/<id>.json         one validated dexterm-strategy/1 document per strategy ($DEXTERM_HOME honoured)
//   ~/.dexterm/strategies/.journal.jsonl    append-only audit: {t, actor, id, ops, beforeHash, afterHash, version, …}
//   ~/.dexterm/strategies/.backtests.json   the last backtest line per strategy hash (for `list`)
//   ~/.dexterm/strategies/.removed/         a removed strategy is moved here, never deleted
//
// Every write validates first (an invalid document is never written), is atomic (tmp + rename, 0600 in a
// 0700 dir) and appends one journal line naming the actor and the before/after content hashes. The shipped
// presets are read-only: `get` falls back to them, and editing one means `create` from it under a new id.
// Ids are the schema's `^[a-z][a-z0-9-]{1,31}$`, checked before any path is built, so an id cannot walk out of
// the directory. Nothing here decides who may change what: the model deny-list and the keypress live with
// the proposal flow (AT-5); this module records the actor it is told.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOps, dextermHome, type PatchOp } from '@dexterm/custom';
import { fmtIssue, loadStrategyFile, validateStrategy, type Issue, type ResolvedStrategy, type Strategy } from './strategy.ts';

export const STRATEGY_ID = /^[a-z][a-z0-9-]{1,31}$/;
const ACTOR = /^[a-z][a-z0-9:._-]{0,63}$/;
/** The most ops one change may carry (the chat tool's limit, §2a). */
export const MAX_OPS = 20;

export const strategiesDir = (home: string): string => join(home, 'strategies');

export interface JournalLine {
  t: number;
  actor: string;
  id: string;
  action: 'create' | 'update' | 'patch' | 'remove';
  ops: PatchOp[];
  /** Inverse ops for a patch (undo); absent for whole-document writes. */
  inverse?: PatchOp[];
  beforeHash: string | null;
  afterHash: string | null;
  version: string | null;
  why?: string;
  proposalId?: string;
  from?: string;
}

export interface ListEntry {
  id: string;
  source: 'user' | 'preset';
  /** A user file with a preset's id shadows the preset. */
  shadowsPreset?: boolean;
  ok: boolean;
  name?: string;
  version?: string;
  hash?: string;
  mode?: 'paper' | 'real' | 'live';
  /** task-1532: the strategy's HIGH RISK label (the yolo preset and its copies). */
  highRisk?: boolean;
  profiles?: string[];
  errors?: Issue[];
  warnings: Issue[];
  lastBacktest?: BacktestLine;
}

export interface BacktestLine { hash: string; t: number; trades: number; netUsd: number; netPct: number; maxDrawdownPct: number; tape: string }

export type WriteResult = { ok: true; strategy: ResolvedStrategy; warnings: Issue[]; journal: JournalLine } | { ok: false; errors: Issue[]; warnings: Issue[] };

export interface StoreOpts { home?: string; env?: NodeJS.ProcessEnv; now?: () => number; presetsDir?: URL }

const fail = (msg: string, path = ''): { ok: false; errors: Issue[]; warnings: Issue[] } => ({ ok: false, errors: [{ path, msg }], warnings: [] });

export class StrategyStore {
  readonly dir: string;
  readonly journalPath: string;
  private readonly now: () => number;
  private readonly presets: URL;

  constructor(o: StoreOpts = {}) {
    this.dir = strategiesDir(o.home ?? dextermHome(o.env));
    this.journalPath = join(this.dir, '.journal.jsonl');
    this.now = o.now ?? Date.now;
    this.presets = o.presetsDir ?? new URL('../assets/strategies/', import.meta.url);
  }

  pathOf(id: string): string {
    if (!STRATEGY_ID.test(id)) throw new Error(`bad strategy id ${JSON.stringify(id)} (lowercase letters, digits and dashes, 2-32 chars)`);
    return join(this.dir, `${id}.json`);
  }

  presetFile(id: string): string { return fileURLToPath(new URL(`${id}.json`, this.presets)); }

  presetIds(): string[] {
    return readdirSync(this.presets).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  }

  userIds(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.json') && !f.startsWith('.') && STRATEGY_ID.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort();
  }

  has(id: string): boolean { return existsSync(this.pathOf(id)); }

  /** The user's file first, else the shipped preset of that id; null when neither exists. */
  get(id: string): (ReturnType<typeof loadStrategyFile> & { source: 'user' | 'preset'; path: string }) | null {
    const user = this.pathOf(id);
    if (existsSync(user)) return { ...loadStrategyFile(user), source: 'user', path: user };
    if (this.presetIds().includes(id)) { const p = this.presetFile(id); return { ...loadStrategyFile(p), source: 'preset', path: p }; }
    return null;
  }

  /** The raw document as stored (user file, else preset), for edits. */
  raw(id: string): Strategy | null {
    const user = this.pathOf(id);
    const path = existsSync(user) ? user : this.presetIds().includes(id) ? this.presetFile(id) : null;
    if (!path) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')) as Strategy; } catch { return null; }
  }

  list(): ListEntry[] {
    const last = this.backtests();
    const users = this.userIds();
    const entry = (id: string, source: 'user' | 'preset'): ListEntry => {
      const r = loadStrategyFile(source === 'user' ? this.pathOf(id) : this.presetFile(id));
      if (!r.ok) return { id, source, ok: false, errors: r.errors, warnings: r.warnings };
      const s = r.strategy;
      return {
        id, source, ok: true, name: s.name, version: s.version, hash: s.hash, mode: s.mode, ...(s.highRisk ? { highRisk: true } : {}), profiles: Object.keys(s.exits.profiles), warnings: r.warnings,
        ...(last[s.hash] ? { lastBacktest: last[s.hash] } : {}),
      };
    };
    const presets = this.presetIds();
    return [
      ...presets.filter((id) => !users.includes(id)).map((id) => entry(id, 'preset')),
      ...users.map((id) => ({ ...entry(id, 'user'), ...(presets.includes(id) ? { shadowsPreset: true } : {}) })),
    ];
  }

  /** Create a new user strategy from a document (its `id` names the file). Refuses an existing id. */
  create(doc: unknown, o: { actor: string; why?: string; from?: string; proposalId?: string }): WriteResult {
    const id = (doc as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !STRATEGY_ID.test(id)) return fail('the document needs a valid id (lowercase letters, digits and dashes, 2-32 chars)', '/id');
    if (this.has(id)) return fail(`a strategy ${id} already exists in ${this.dir} (edit it, or pick another id)`, '/id');
    return this.write(id, doc, null, { ...o, action: 'create', ops: [{ op: 'add', path: '', value: doc }] });
  }

  /** Copy a preset or a stored strategy under a new id (and name). */
  createFrom(fromId: string, newId: string, o: { actor: string; name?: string; why?: string }): WriteResult {
    const base = this.raw(fromId);
    if (!base) return fail(`no strategy or preset ${fromId}`);
    const doc = { ...base, id: newId, version: '1.0.0', ...(o.name ? { name: o.name } : {}) };
    return this.create(doc, { actor: o.actor, why: o.why, from: fromId });
  }

  /** Replace a user strategy with a whole new document (same id). The version must go up. */
  update(id: string, doc: unknown, o: { actor: string; why?: string; proposalId?: string }): WriteResult {
    if (!this.has(id)) return fail(`no user strategy ${id} (presets are read-only: create a copy first)`);
    if ((doc as { id?: unknown } | null)?.id !== id) return fail(`the document id must stay ${id}`, '/id');
    return this.write(id, doc, this.currentHash(id), { ...o, action: 'update', ops: [{ op: 'replace', path: '', value: doc }] });
  }

  /**
   * Apply JSON-patch ops (≤ MAX_OPS) to a user strategy. The patch version is bumped unless the ops set
   * `/version` themselves; `/id` cannot change. The journal line carries the ops and their inverse.
   */
  patch(id: string, ops: PatchOp[], o: { actor: string; why?: string; proposalId?: string }): WriteResult {
    if (!this.has(id)) return fail(`no user strategy ${id} (presets are read-only: create a copy first)`);
    if (!Array.isArray(ops) || ops.length === 0) return fail('no ops');
    if (ops.length > MAX_OPS) return fail(`${ops.length} ops is more than ${MAX_OPS} in one change`);
    if (ops.some((x) => x.path === '/id' || x.path === '')) return fail('the id and the whole document cannot be patched', '/id');
    const before = this.raw(id);
    if (!before) return fail(`${id} is not readable JSON`);
    let next: Strategy, inverse: PatchOp[];
    try { ({ doc: next, inverse } = applyOps(before, ops)); } catch (e) { return fail((e as Error).message); }
    if (!ops.some((x) => x.path === '/version')) next = { ...next, version: bumpPatch(before.version) };
    return this.write(id, next, this.currentHash(id), { ...o, action: 'patch', ops, inverse });
  }

  /** Move a user strategy to .removed/ (never deleted) and journal it. */
  remove(id: string, o: { actor: string; why?: string }): { ok: true; journal: JournalLine; movedTo: string } | { ok: false; errors: Issue[]; warnings: Issue[] } {
    if (!this.has(id)) return fail(`no user strategy ${id}`);
    const t = this.now();
    const before = this.currentHash(id);
    const dest = join(this.dir, '.removed');
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    const movedTo = join(dest, `${id}.${t}.json`);
    renameSync(this.pathOf(id), movedTo);
    const journal: JournalLine = { t, actor: checkActor(o.actor), id, action: 'remove', ops: [{ op: 'remove', path: '' }], beforeHash: before, afterHash: null, version: null, ...(o.why ? { why: o.why } : {}) };
    this.append(journal);
    return { ok: true, journal, movedTo };
  }

  journal(id?: string): JournalLine[] {
    if (!existsSync(this.journalPath)) return [];
    const out: JournalLine[] = [];
    for (const l of readFileSync(this.journalPath, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l) as JournalLine; if (!id || j.id === id) out.push(j); } catch { /* a torn last line is skipped, never rewritten */ }
    }
    return out;
  }

  backtests(): Record<string, BacktestLine> {
    const p = join(this.dir, '.backtests.json');
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, BacktestLine>; } catch { return {}; }
  }

  /** Remember the last backtest of a strategy hash (shown by `list`; a changed strategy has a new hash). */
  recordBacktest(line: BacktestLine): void {
    const all = this.backtests();
    all[line.hash] = line;
    const keep = Object.values(all).sort((a, b) => b.t - a.t).slice(0, 200);
    this.atomic(join(this.dir, '.backtests.json'), JSON.stringify(Object.fromEntries(keep.map((b) => [b.hash, b])), null, 2) + '\n');
  }

  // ───────────────────────────── internals ─────────────────────────────

  private currentHash(id: string): string | null {
    const r = loadStrategyFile(this.pathOf(id));
    return r.ok ? r.strategy.hash : null;
  }

  private write(id: string, doc: unknown, beforeHash: string | null, o: { actor: string; action: JournalLine['action']; ops: PatchOp[]; inverse?: PatchOp[]; why?: string; proposalId?: string; from?: string }): WriteResult {
    let actor: string;
    try { actor = checkActor(o.actor); } catch (e) { return fail((e as Error).message); }
    const r = validateStrategy(doc);
    if (!r.ok) return r;
    const prev = this.has(id) ? this.raw(id) : null;
    if (prev && o.action !== 'create' && !semverGreater(r.strategy.version, prev.version)) return { ok: false, errors: [{ path: '/version', msg: `version ${r.strategy.version} must be above the stored ${prev.version}` }], warnings: r.warnings };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.atomic(this.pathOf(id), JSON.stringify(doc, null, 2) + '\n');
    const journal: JournalLine = {
      t: this.now(), actor, id, action: o.action, ops: o.ops, ...(o.inverse ? { inverse: o.inverse } : {}),
      beforeHash, afterHash: r.strategy.hash, version: r.strategy.version,
      ...(o.why ? { why: o.why.slice(0, 400) } : {}), ...(o.proposalId ? { proposalId: o.proposalId } : {}), ...(o.from ? { from: o.from } : {}),
    };
    this.append(journal);
    return { ok: true, strategy: r.strategy, warnings: r.warnings, journal };
  }

  private append(j: JournalLine): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.journalPath, `${JSON.stringify(j)}\n`, { mode: 0o600 });
  }

  private atomic(path: string, text: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  }
}

function checkActor(a: string): string {
  if (typeof a !== 'string' || !ACTOR.test(a)) throw new Error(`bad actor ${JSON.stringify(a)}`);
  return a;
}

export function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.1';
}

export function semverGreater(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export const fmtIssues = (xs: Issue[]): string => xs.map(fmtIssue).join('; ');
