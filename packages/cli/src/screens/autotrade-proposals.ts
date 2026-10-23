// dexterm — chat proposals on the AUTOTRADE screen (task-1507 AT-5, AUTOTRADE-SPEC §2a). PAPER ONLY.
//
// The analyst (or any MCP agent) can only PROPOSE a strategy edit: `strategy_propose_edit/new` write a proposal file
// and nothing else. This module is the ONLY path that applies one, and it runs only on the user's physical keys:
//
//   o   on the strategies list opens the diff card of the newest pending proposal (the selected strategy's first)
//   y   applies a tighter or neutral edit
//   y   on a LOOSER edit opens the "less safe" popup (every less-safe field named) and a SECOND y applies it
//   n   dismisses the proposal · esc (or any other key) closes the card and leaves it pending
//
// Applying re-checks everything from scratch (`checkProposal`: the base hash, the model deny-list on the result,
// the validator and a fresh risk delta: the stored riskDelta is never trusted), then writes through StrategyStore
// (a new version, one `.journal.jsonl` line naming the proposer, the proposal id, the ops and both hashes).
// The key loop feeds `reviewKey` decoded keyboard keys only; no voice, pipe or agent path reaches it.

import { applyOps, dextermHome } from '@dexterm/custom';
import * as engine from '@dexterm/autotrade';
import type { StrategyStore } from '@dexterm/autotrade';
import { ProposalFiles, checkProposal, proposalCardView, type Engine, type ProposalCheck, type StrategyProposalRecord } from '@dexterm/mcp';
import type { Key } from '@dexterm/tui';
import type { AutotradeUi, StrategyProposal } from './autotrade-ui.ts';

const ENGINE: Engine = { at: engine, applyOps };

/** The review card: the proposal, its fresh check, and the physical keys pressed on it so far. */
export interface ProposalReview {
  rec: StrategyProposalRecord;
  check: ProposalCheck;
  stage: 'card' | 'less-safe';
  keys: string[];
}

/** Pending proposals as display cards, re-read at most once a second (the list view asks every frame). */
export function proposalSource(files: ProposalFiles, now: () => number = Date.now): { cards: () => StrategyProposal[]; pending: () => StrategyProposalRecord[]; invalidate: () => void } {
  let at = -Infinity;
  let recs: StrategyProposalRecord[] = [];
  const pending = (): StrategyProposalRecord[] => {
    const t = now();
    if (t - at >= 1000) { try { recs = files.list({ status: 'pending' }); } catch { recs = []; } at = t; }
    return recs;
  };
  return { pending, cards: () => pending().map(proposalCardView), invalidate: () => { at = -Infinity; } };
}

export const proposalFilesFor = (env: NodeJS.ProcessEnv = process.env): ProposalFiles => new ProposalFiles(dextermHome(env));

const inputOf = (r: StrategyProposalRecord) => ({ kind: r.kind, id: r.id, ops: r.ops, from: r.from, name: r.name, why: r.why });

/** Re-check a stored proposal against the strategy as it is NOW (stale when the strategy changed since). */
export function recheck(store: StrategyStore, rec: StrategyProposalRecord): ProposalCheck {
  const c = checkProposal(ENGINE, store, inputOf(rec));
  if (c.ok && c.before.hash !== rec.beforeHash) {
    return { ok: false, stage: 'input', errors: [{ path: `/${rec.id}`, msg: `${rec.id} changed since this proposal (it was made on ${rec.beforeHash}, it is ${c.before.hash} now): dismiss it with n and ask again` }], warnings: [] };
  }
  return c;
}

/** The keys a proposal needs: one for a tighter or neutral edit, two (the less-safe popup) for a looser one. */
export const keysNeeded = (c: ProposalCheck): number => (c.ok && c.riskDelta === 'looser' ? 2 : 1);

/**
 * Apply a proposal. `keys` must be the physical keys the user pressed on its card (`reviewKey` collects them);
 * a looser edit needs two. Returns the toast line. Nothing else in the app calls the store with a proposal id.
 */
export function applyProposal(store: StrategyStore, files: ProposalFiles, rec: StrategyProposalRecord, keys: readonly string[], now: number = Date.now()): { ok: boolean; message: string } {
  if (rec.status !== 'pending') return { ok: false, message: `proposal ${rec.proposalId} is already ${rec.status}` };
  const c = recheck(store, rec);
  if (!c.ok) return { ok: false, message: `not applied: ${c.errors.map(engine.fmtIssue).join('; ')}` };
  const yes = keys.filter((k) => k === 'y').length;
  const need = keysNeeded(c);
  if (yes < need) return { ok: false, message: `not applied: a LOOSER edit needs a second keypress (${yes} of ${need})` };
  const why = `${rec.why} · applied by keypress${need === 2 ? ' after the less-safe popup' : ''}`.slice(0, 300);
  const w = rec.kind === 'edit'
    ? store.patch(rec.id, c.effectiveOps, { actor: rec.actor, why, proposalId: rec.proposalId })
    : store.create(c.afterRaw, { actor: rec.actor, why, from: rec.from, proposalId: rec.proposalId });
  if (!w.ok) return { ok: false, message: `not applied: ${w.errors.map(engine.fmtIssue).join('; ')}` };
  if (w.strategy.hash !== c.after.hash) return { ok: false, message: `applied, but the stored hash ${w.strategy.hash} differs from the proposal's ${c.after.hash}: check the journal` };
  files.resolve(rec.proposalId, 'applied', { appliedVersion: w.strategy.version, keys: [...keys] }, now);
  return { ok: true, message: `${rec.kind === 'new' ? 'created' : 'applied'} ${rec.id} v${w.strategy.version} (${c.riskDelta}) · journaled with ${rec.proposalId}` };
}

// ───────────────────────────── the card's keys (AutotradeUi) ─────────────────────────────

/** `o`: open the newest pending proposal (the selected strategy's first). Returns the notice. */
export function openReview(ui: AutotradeUi): string {
  const src = ui.deps.proposalSource;
  if (!src) return 'chat proposals are not available on this run';
  src.invalidate();
  const pending = src.pending();
  if (!pending.length) return 'no chat proposals · ask the analyst (a) to change a strategy; its diff card shows up here';
  const sel = ui.entries[ui.selected]?.id;
  const rec = pending.find((p) => p.id === sel) ?? pending[0];
  ui.review = { rec, check: recheck(ui.deps.store, rec), stage: 'card', keys: [] };
  return '';
}

/** A key while the card is open. Returns the notice (null keeps the card's own text). */
export function reviewKey(ui: AutotradeUi, key: Key): string | null {
  const rv = ui.review;
  if (!rv) return null;
  const ch = key.name === 'char' && !key.ctrl && !key.alt ? key.ch : null;
  const src = ui.deps.proposalSource;
  const files = ui.deps.proposalFiles;
  if (ch === 'n' && files) {
    files.resolve(rv.rec.proposalId, 'dismissed', {}, ui.deps.now());
    ui.review = null; src?.invalidate();
    return `dismissed ${rv.rec.proposalId} (${rv.rec.id} unchanged)`;
  }
  if (ch !== 'y') { ui.review = null; return 'proposal left pending (o reopens it)'; }
  if (!rv.check.ok) return `cannot apply: ${rv.check.errors.map(engine.fmtIssue).join('; ')} · n dismisses it`;
  rv.keys.push('y');
  if (rv.check.riskDelta === 'looser' && rv.stage === 'card') { rv.stage = 'less-safe'; return 'LESS SAFE: y again applies it · any other key cancels'; }
  if (!files) { ui.review = null; return 'chat proposals are not available on this run'; }
  const r = applyProposal(ui.deps.store, files, rv.rec, rv.keys, ui.deps.now());
  ui.review = null; src?.invalidate();
  return r.message;
}
