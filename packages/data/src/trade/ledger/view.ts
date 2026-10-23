// task-1530 — the ledger VIEW: what the file holds plus what the sources hold that it does not have yet.
//
// Reads (`dexterm ledger trades|summary|export`, the MCP ledger tools, the PnL card) never wait for a sync and
// never write: they fold the file's events together with fresh drafts from the sources, in memory. Only
// `dexterm ledger sync` appends those drafts to the file (and so gives them a place in the hash chain).

import { join } from 'node:path';
import { paperAgentJournalPath } from '../agent/rendezvous.ts';
import { dextermHomeDir, readTradeLedger, tradeLedgerPath, type LedgerRead } from './file.ts';
import { foldTrades, type TradeRow } from './fold.ts';
import { importDeskJournal, importPaperWallet, type RunHint, type SourceResult } from './sources.ts';
import { LEDGER_VERSION, type Draft, type LedgerEvent } from './schema.ts';

export interface SourcePaths { deskJournal: string; walletDb: string | null }

export function defaultSourcePaths(env: NodeJS.ProcessEnv = process.env, walletDb: string | null = null): SourcePaths {
  return {
    deskJournal: paperAgentJournalPath(env),
    walletDb,
  };
}

/** Drafts from every data-layer source (run ledgers are added by the caller that can read them). */
export function collectDataSources(p: SourcePaths, o: { runs?: ReadonlyMap<string, RunHint> } = {}): SourceResult[] {
  const desk = importDeskJournal(p.deskJournal, { walletDb: p.walletDb, ...(o.runs ? { runs: o.runs } : {}) });
  const out: SourceResult[] = [desk];
  if (p.walletDb) out.push(importPaperWallet(p.walletDb, desk.fillIds));
  return out;
}

export interface LedgerView {
  path: string;
  file: LedgerRead;
  /** Drafts from the sources that the file does not hold yet (a sync would append exactly these). */
  pending: Draft[];
  sources: { label: string; source: string; events: number; pending: number; note: string | null; problem: string | null }[];
  events: LedgerEvent[];
  trades: TradeRow[];
}

/** Fold the file plus the pending drafts. A file that fails its check still folds (the view says so). */
export function buildLedgerView(path: string, sources: readonly SourceResult[], now = Date.now()): LedgerView {
  const file = readTradeLedger(path);
  const have = new Set<string>();
  for (const e of file.events) if ('ref' in e && typeof e.ref === 'string') have.add(e.ref);
  const pending: Draft[] = [];
  const meta: LedgerView['sources'] = [];
  for (const s of sources) {
    let n = 0;
    for (const d of s.drafts) {
      const ref = (d as { ref?: string }).ref;
      if (!ref || have.has(ref)) continue;
      have.add(ref); pending.push(d); n++;
    }
    meta.push({ label: s.label, source: s.source, events: s.events, pending: n, note: s.note, problem: s.problem });
  }
  let seq = file.events.length;
  const events: LedgerEvent[] = [...file.events, ...pending.map((d) => ({ ...d, seq: ++seq, v: LEDGER_VERSION, prev: 'pending', hash: 'pending' }) as unknown as LedgerEvent)];
  return { path, file, pending, sources: meta, events, trades: foldTrades(events, { now }) };
}

export { tradeLedgerPath };
