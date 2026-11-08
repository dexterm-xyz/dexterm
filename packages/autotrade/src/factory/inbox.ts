// The factory's evidence snapshot and its candidate inbox (task-2167). PAPER ONLY. Files only, no logic that needs
// the run: generate.ts writes the snapshot and admits queued offers, offer.ts runs the offer-time gate.
//
//   evidence.json     the evidence table the last full run showed its analyst: window, held-out start, the text and
//                     every citable number. An external agent reads it (factory_evidence) and may cite only these.
//   inbox/<id>.json   one offered candidate: the proposal (ops on one parent + rationale + citations), who offered it
//                     (`mcp:<client>`), the snapshot it was checked against, and its status (queued, admitted, rejected).

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJsonAtomic } from '../ledger.ts';
import { factoryDir } from './config.ts';
import type { Proposal } from './analyst.ts';
import type { EvidenceTable } from './evidence.ts';

export const EVIDENCE_SNAPSHOT_SCHEMA = 'dexterm-factory-evidence/1';
export const OFFER_SCHEMA = 'dexterm-factory-offer/1';

export const evidenceSnapshotPath = (home: string): string => join(factoryDir(home), 'evidence.json');
export const inboxDir = (home: string): string => join(factoryDir(home), 'inbox');
const offerPath = (home: string, offerId: string): string => join(inboxDir(home), `${offerId}.json`);
export const OFFER_ID = /^of_[a-z0-9]{6,12}_[0-9a-f]{6}$/;
export const newOfferId = (now: number): string => `of_${now.toString(36)}_${randomBytes(3).toString('hex')}`;

export interface EvidenceSnapshot {
  schema: typeof EVIDENCE_SNAPSHOT_SCHEMA;
  runId: string;
  at: number;
  window: EvidenceTable['window'];
  heldOut: EvidenceTable['heldOut'];
  /** Epoch ms where the evidence window ends: nothing at or after it was shown. */
  windowEndMs: number;
  /** The strategies in the table: ref, id, rules hash. */
  rows: { ref: string; id: string; rulesHash: string }[];
  text: string;
  numbers: Record<string, number>;
  /** The other numbers a rationale may use (lessons, config values, small counts), as the run allowed them. */
  extra: number[];
}

export function saveEvidenceSnapshot(home: string, s: EvidenceSnapshot): void {
  mkdirSync(factoryDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(evidenceSnapshotPath(home), s);
}

export function loadEvidenceSnapshot(home: string): EvidenceSnapshot | null {
  const p = evidenceSnapshotPath(home);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as EvidenceSnapshot;
    return j && j.schema === EVIDENCE_SNAPSHOT_SCHEMA && j.numbers && typeof j.windowEndMs === 'number' ? j : null;
  } catch { return null; }
}

export type OfferStatus = 'queued' | 'admitted' | 'rejected';

export interface CandidateOffer {
  schema: typeof OFFER_SCHEMA;
  offerId: string;
  /** `mcp:<client>`: who acted as the generator. */
  source: string;
  at: number;
  /** The evidence snapshot the offer was checked against (its window ends before every held-out day). */
  snapshotRunId: string;
  windowEndMs: number;
  window: EvidenceTable['window'];
  proposal: Proposal;
  rulesHash: string;
  status: OfferStatus;
  candidateId: string | null;
  reasons: string[];
  resolvedAt: number | null;
  runId: string | null;
}

export function saveOffer(home: string, o: CandidateOffer): void {
  mkdirSync(inboxDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(offerPath(home, o.offerId), o);
}

export function loadOffer(home: string, offerId: string): CandidateOffer | null {
  if (!OFFER_ID.test(offerId)) return null;
  const p = offerPath(home, offerId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as CandidateOffer; } catch { return null; }
}

/** Every offer, oldest first. */
export function listOffers(home: string, status?: OfferStatus): CandidateOffer[] {
  const d = inboxDir(home);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => loadOffer(home, f.slice(0, -5))).filter((x): x is CandidateOffer => !!x && (!status || x.status === status)).sort((a, b) => a.at - b.at);
}

export function resolveOffer(home: string, o: CandidateOffer, r: { status: Exclude<OfferStatus, 'queued'>; candidateId?: string | null; reasons?: string[]; runId: string; now: number }): CandidateOffer {
  const next: CandidateOffer = { ...o, status: r.status, candidateId: r.candidateId ?? null, reasons: (r.reasons ?? []).slice(0, 12).map((x) => x.slice(0, 300)), resolvedAt: r.now, runId: r.runId };
  saveOffer(home, next);
  return next;
}
