// An external agent acts as the factory's generator (task-2167). PAPER ONLY.
//
// `offerCandidate` is the offer-time half of the SAME gate the factory's own analyst reply goes through:
//   - the reply shape (parseProposal: base, parents, name, ops on /entry + /exits, rationale for every rule, citations);
//     a full dexterm-strategy/1 document is accepted too and turned into those ops against its base, and any other
//     difference from the base is refused by name: mode (a candidate is always paper), bankroll, sizing, risk, agent,
//     execution (the caps and the Claude budget come from the base and only the user changes them);
//   - the ops policy, the result-level guarded fields, the validator (buildCandidate);
//   - the number cross-check against the evidence snapshot the agent could read (factory_evidence), so a number that is
//     not in that evidence (a made-up mean, a borrowed held-out figure) is refused; the claim-wording guard;
//   - the rules-hash duplicate and near-duplicate checks, against stored strategies, generated ones and queued offers.
// A passing offer is queued in inbox/<id>.json. The next factory run admits it exactly like an analyst reply (store as
// GENERATED, paper, decide auto; held-out test on days after the snapshot's window, which the snapshot never showed;
// backtested rung; queued for a paper forward test under the existing caps). An offer never sets a bankroll, a cap, a
// mode, never promotes, and never starts anything itself.

import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PatchOp } from '@dexterm/custom';
import { rulesHash } from '../journey.ts';
import type { StrategyStore } from '../store.ts';
import { builtinProfiles, type ResolvedStrategy } from '../strategy.ts';
import { buildCandidate, crossCheck, inlinedDoc, jsonNumbers, parseProposal, wordingProblems, MAX_FACTORY_OPS, type Proposal } from './analyst.ts';
import { factoryHalt, loadFactoryConfig } from './config.ts';
import { rulesView } from './evidence.ts';
import { isActiveGenerated, listGenerated, nearDuplicate } from './generate.ts';
import { inboxDir, listOffers, loadEvidenceSnapshot, newOfferId, OFFER_SCHEMA, saveOffer, type CandidateOffer } from './inbox.ts';

/** At most this many offers wait in the inbox, and this many are accepted per day, per home (any agent). */
export const OFFER_LIMITS = { queued: 3, perDay: 6 } as const;
export const OFFER_SOURCE = /^mcp:[a-z0-9][a-z0-9._-]{0,40}$/;

/** Top-level fields that come from the base and only the user changes (a difference is refused, never copied). */
const BASE_OWNED = ['bankroll', 'sizing', 'risk', 'agent', 'execution'] as const;
/** Top-level fields the factory sets itself (any value offered is ignored). */
const FACTORY_SET = new Set(['id', 'name', 'version', 'description', 'hash', 'schema', 'kind', 'mode']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const esc = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

function diffOps(a: unknown, b: unknown, path: string, out: PatchOp[]): void {
  if (same(a, b)) return;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!(k in b)) out.push({ op: 'remove', path: `${path}/${esc(k)}` });
    for (const k of Object.keys(b)) {
      if (!(k in a)) out.push({ op: 'add', path: `${path}/${esc(k)}`, value: b[k] });
      else diffOps(a[k], b[k], `${path}/${esc(k)}`, out);
    }
    return;
  }
  // arrays of the same length diff element by element, so a change inside one profile stays a narrow path the policy sees
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) { a.forEach((x, i) => diffOps(x, b[i], `${path}/${i}`, out)); return; }
  out.push({ op: 'replace', path, value: b });
}

/** A full strategy document as ops on its base's /entry and /exits; anything else that differs is refused by name. */
export function opsFromStrategy(base: ResolvedStrategy, doc: unknown): { ok: true; ops: PatchOp[] } | { ok: false; problems: string[] } {
  if (!isObj(doc)) return { ok: false, problems: ['strategy must be a dexterm-strategy/1 object'] };
  const problems: string[] = [];
  if (doc.mode !== undefined && doc.mode !== 'paper') problems.push(`mode "${String(doc.mode).slice(0, 12)}": a generated candidate is always paper; real mode is the user's alone (promotion on their own terminal)`);
  const b = inlinedDoc(base) as unknown as Record<string, unknown>;
  for (const k of BASE_OWNED) if (k in doc && !same(doc[k], b[k])) problems.push(`/${k} differs from the base ${base.id}: bankroll, sizing, risk, agent (incl. its Claude budget) and execution come from the base; only the user changes them`);
  for (const k of Object.keys(doc)) if (!FACTORY_SET.has(k) && !(BASE_OWNED as readonly string[]).includes(k) && k !== 'entry' && k !== 'exits') problems.push(`/${k.slice(0, 40)} is not a field a candidate may set (only /entry and /exits differ from the base)`);
  if (problems.length) return { ok: false, problems };
  // task-2167 r1 (verifier task-2173): a document as strategy_get returns it names shipped profiles as "builtin:<id>";
  // the base is compared inlined, so resolve those refs from the same library the validator uses before diffing. An
  // unchanged builtin profile then diffs to nothing, and a builtin that is new to the strategy becomes an inlined profile
  // that the guarded-field check judges like any other new profile. An unknown ref stays a string and is refused
  // (own keys only: `builtin:constructor` / `builtin:toString` are unknown refs, not Object.prototype members; task-2175 residual).
  const lib = builtinProfiles();
  const exits = isObj(doc.exits) && Array.isArray(doc.exits.profiles)
    ? { ...doc.exits, profiles: doc.exits.profiles.map((p) => (typeof p === 'string' && p.startsWith('builtin:') && Object.hasOwn(lib, p.slice('builtin:'.length)) ? JSON.parse(JSON.stringify(lib[p.slice('builtin:'.length)])) : p)) }
    : doc.exits;
  const ops: PatchOp[] = [];
  if ('entry' in doc) diffOps(b.entry, doc.entry, '/entry', ops);
  if ('exits' in doc) diffOps(b.exits, exits, '/exits', ops);
  if (!ops.length) return { ok: false, problems: [`the strategy is the same as its base ${base.id} on /entry and /exits`] };
  if (ops.length > MAX_FACTORY_OPS) return { ok: false, problems: [`the strategy differs from ${base.id} in ${ops.length} places (at most ${MAX_FACTORY_OPS}); change fewer rules or offer ops`] };
  return { ok: true, ops };
}

export interface OfferInput {
  base?: unknown; parents?: unknown; name?: unknown;
  /** a full dexterm-strategy/1 document (its /entry and /exits become the ops) … */
  strategy?: unknown;
  /** … or the ops themselves (the analyst's own form). */
  ops?: unknown;
  rationale?: unknown; citations?: unknown; retire?: unknown;
}

export type OfferResult = { ok: true; offer: CandidateOffer; queuedAhead: number } | { ok: false; problems: string[]; reason: 'stopped' | 'no-evidence' | 'limit' | 'gate' };

/** task-2167 r1: the limits are check-then-write, so one offer at a time per home (inbox/.offer.lock, stale after 30 s). */
function offerLock(home: string, now: number): (() => void) | null {
  mkdirSync(inboxDir(home), { recursive: true, mode: 0o700 });
  const p = join(inboxDir(home), '.offer.lock');
  try { if (now - statSync(p).mtimeMs > 30_000) unlinkSync(p); } catch { /* no lock */ }
  try { writeFileSync(p, String(process.pid), { flag: 'wx', mode: 0o600 }); } catch { return null; }
  return () => { try { unlinkSync(p); } catch { /* gone */ } };
}

export function offerCandidate(home: string, store: StrategyStore, input: OfferInput, o: { source: string; now?: number }): OfferResult {
  const now = o.now ?? Date.now();
  if (!OFFER_SOURCE.test(o.source)) return { ok: false, reason: 'gate', problems: ['bad source (expected mcp:<client>)'] };
  const release = offerLock(home, Date.now());
  if (!release) return { ok: false, reason: 'limit', problems: ['another offer is being checked on this home; try again in a few seconds'] };
  try { return offerLocked(home, store, input, { ...o, now }); } finally { release(); }
}

function offerLocked(home: string, store: StrategyStore, input: OfferInput, o: { source: string; now: number }): OfferResult {
  const now = o.now;
  if (!OFFER_SOURCE.test(o.source)) return { ok: false, reason: 'gate', problems: ['bad source (expected mcp:<client>)'] };
  const halt = factoryHalt(home);
  if (halt) return { ok: false, reason: 'stopped', problems: [`the factory is paused (${halt.kind} by ${halt.info.by}); offers wait until the user resumes it`] };
  const cfg = loadFactoryConfig(home);
  if (!cfg.ok) return { ok: false, reason: 'gate', problems: [`factory.json is invalid: ${cfg.errors.join('; ')}`] };
  const snap = loadEvidenceSnapshot(home);
  if (!snap) return { ok: false, reason: 'no-evidence', problems: ['there is no evidence snapshot yet: a full factory run writes it (factory_run_now, or the schedule); then read factory_evidence and cite from it'] };
  const offers = listOffers(home);
  const queued = offers.filter((x) => x.status === 'queued');
  if (queued.length >= OFFER_LIMITS.queued) return { ok: false, reason: 'limit', problems: [`${queued.length} offers already wait in the inbox (at most ${OFFER_LIMITS.queued}); the next factory run admits or rejects them`] };
  if (offers.filter((x) => now - x.at < 86_400_000).length >= OFFER_LIMITS.perDay) return { ok: false, reason: 'limit', problems: [`at most ${OFFER_LIMITS.perDay} offers per day on this home`] };
  const active = listGenerated(home).filter(isActiveGenerated).length;
  if (active + queued.length >= cfg.config.maxActiveGenerated) return { ok: false, reason: 'limit', problems: [`${active} generated strategies are active and ${queued.length} offers queued (cap maxActiveGenerated ${cfg.config.maxActiveGenerated}, the user's); retire one first`] };

  // the reply shape: the same parser the analyst's reply goes through
  const baseId = typeof input.base === 'string' ? input.base : '';
  const resolved = (id: string): ResolvedStrategy | null => { const g = store.get(id); return g && g.ok ? g.strategy : null; };
  const baseS = baseId ? resolved(baseId) : null;
  let ops = input.ops;
  if (input.strategy !== undefined) {
    if (input.ops !== undefined) return { ok: false, reason: 'gate', problems: ['offer either a full strategy or ops, not both'] };
    if (!baseS) return { ok: false, reason: 'gate', problems: [`base ${baseId.slice(0, 32) || '(missing)'} is not a strategy here (factory_evidence lists the ones you may build on)`] };
    const d = opsFromStrategy(baseS, input.strategy);
    if (!d.ok) return { ok: false, reason: 'gate', problems: d.problems };
    ops = d.ops;
  }
  const parsed = parseProposal(JSON.stringify({ base: input.base, parents: input.parents, name: input.name, ops, rationale: input.rationale, citations: input.citations, retire: input.retire ?? [] }));
  if (!parsed.ok) return { ok: false, reason: 'gate', problems: parsed.problems };
  const p: Proposal = parsed.proposal;
  const inSnap = new Set(snap.rows.map((r) => r.id));
  const notShown = p.parents.filter((x) => !inSnap.has(x));
  if (notShown.length) return { ok: false, reason: 'gate', problems: [`base/parents not in the evidence you were shown: ${notShown.join(', ')} (factory_evidence lists them)`] };
  if (!baseS) return { ok: false, reason: 'gate', problems: [`base ${p.base} no longer exists or no longer validates`] };
  const parentsS = p.parents.map(resolved);
  if (parentsS.some((x) => !x)) return { ok: false, reason: 'gate', problems: ['a parent no longer exists or no longer validates'] };
  const built = buildCandidate(baseS, p, { id: 'gen-offer-check', summary: p.rationale.summary });
  if (!built.ok) return { ok: false, reason: 'gate', problems: built.problems.map((x) => `invalid strategy: ${x}`) };
  const ruleNums = [...jsonNumbers(rulesView(built.strategy)), ...parentsS.flatMap((s) => jsonNumbers(rulesView(s!)))];
  const cc = crossCheck({ proposal: p, evidence: new Map(Object.entries(snap.numbers)), extra: snap.extra, rules: ruleNums });
  if (cc.length) return { ok: false, reason: 'gate', problems: cc.map((x) => `numbers: ${x}`) };
  const wd = wordingProblems(p);
  if (wd.length) return { ok: false, reason: 'gate', problems: wd };
  const rh = rulesHash(built.strategy);
  const known = store.list().filter((e) => e.ok).map((e) => resolved(e.id)).filter((s): s is ResolvedStrategy => !!s);
  if (known.some((s) => rulesHash(s) === rh) || listGenerated(home).some((g) => g.rulesHash === rh) || queued.some((x) => x.rulesHash === rh)) return { ok: false, reason: 'gate', problems: [`duplicate: the same rules (rules hash ${rh}) already exist or wait in the inbox`] };
  const near = known.find((s) => nearDuplicate(built.strategy, s));
  if (near) return { ok: false, reason: 'gate', problems: [`near duplicate of ${near.id}: every change is a number within 5%`] };

  const offer: CandidateOffer = {
    schema: OFFER_SCHEMA, offerId: newOfferId(now), source: o.source, at: now, snapshotRunId: snap.runId, windowEndMs: snap.windowEndMs, window: snap.window,
    proposal: p, rulesHash: rh, status: 'queued', candidateId: null, reasons: [], resolvedAt: null, runId: null,
  };
  saveOffer(home, offer);
  return { ok: true, offer, queuedAhead: queued.length };
}
