// task-1530 — the unified trade ledger FILE: $DEXTERM_HOME/ledger/trades.jsonl (0600, the directory 0700).
//
// Appends only. An append re-reads the file, verifies the whole chain, skips any draft whose `ref` is already
// there, and writes the new lines in one append, all under a lock file, so two syncs never interleave. A file whose
// chain is broken is never appended to (the user sees where it broke with `dexterm ledger verify`); a file written
// by a newer dexterm is refused rather than half-read.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GENESIS, LEDGER_SCHEMA, LEDGER_VERSION, ledgerHash, verifyLedger, type Draft, type LedgerCheck, type LedgerEvent } from './schema.ts';

export function dextermHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
}

export const tradeLedgerPath = (env: NodeJS.ProcessEnv = process.env): string => join(dextermHomeDir(env), 'ledger', 'trades.jsonl');

export interface LedgerRead { events: LedgerEvent[]; check: LedgerCheck; exists: boolean }

/** Read and verify. A missing file is an empty, valid ledger. A line that is not JSON fails the check at that line. */
export function readTradeLedger(path: string): LedgerRead {
  if (!existsSync(path)) return { events: [], check: { ok: true, events: 0, head: GENESIS }, exists: false };
  const events: LedgerEvent[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    try { events.push(JSON.parse(l) as LedgerEvent); } catch {
      return { events, check: { ok: false, events: events.length, at: events.length + 1, error: 'a line is not JSON (the file was edited or cut off)' }, exists: true };
    }
  }
  const head = events[0] as Partial<{ kind: string; schema: string }> | undefined;
  if (head && head.kind === 'header' && head.schema !== LEDGER_SCHEMA) {
    return { events, check: { ok: false, events: events.length, at: 1, error: `unknown ledger schema ${JSON.stringify(head.schema)} (this build reads ${LEDGER_SCHEMA})` }, exists: true };
  }
  return { events, check: verifyLedger(events as unknown as Record<string, unknown>[]), exists: true };
}

export class LedgerBusyError extends Error { constructor(m: string) { super(m); this.name = 'LedgerBusyError'; } }
export class LedgerBrokenError extends Error { constructor(m: string) { super(m); this.name = 'LedgerBrokenError'; } }

const LOCK_STALE_MS = 60_000;

function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  let fd: number | null = null;
  for (let attempt = 0; attempt < 2 && fd === null; attempt++) {
    try { fd = openSync(lock, 'wx', 0o600); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { try { unlinkSync(lock); } catch { /* raced */ } continue; }
      throw new LedgerBusyError('another ledger sync is running (try again in a few seconds)');
    }
  }
  if (fd === null) throw new LedgerBusyError('could not take the ledger lock');
  try { writeSync(fd, String(process.pid)); return fn(); } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch { /* gone */ }
  }
}

export interface AppendResult { added: number; skipped: number; head: string; events: number }

/**
 * Append drafts to the ledger (creating it with its header when missing). Drafts whose `ref` is already in the
 * file are skipped, so an import can be re-run any number of times. `now` stamps the header only.
 */
export function appendTradeLedger(path: string, drafts: readonly Draft[], now = Date.now()): AppendResult {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withLock(path, () => {
    const cur = readTradeLedger(path);
    if (!cur.check.ok) throw new LedgerBrokenError(`the ledger at ${path} fails its check at line ${cur.check.at}: ${cur.check.error}. Nothing was appended.`);
    const seen = new Set<string>();
    for (const e of cur.events) if ('ref' in e && typeof e.ref === 'string') seen.add(e.ref);
    let prev = cur.events.length ? cur.events[cur.events.length - 1].hash : GENESIS;
    let seq = cur.events.length;
    const out: string[] = [];
    const push = (d: Record<string, unknown>) => {
      const e: Record<string, unknown> = { ...d, seq: ++seq, v: LEDGER_VERSION };
      delete e.prev; delete e.hash;
      const h = ledgerHash(prev, e);
      e.prev = prev; e.hash = h; prev = h;
      out.push(JSON.stringify(e));
    };
    if (!cur.events.length) push({ kind: 'header', t: now, schema: LEDGER_SCHEMA, createdAt: now });
    let skipped = 0;
    for (const d of drafts) {
      const ref = (d as { ref?: unknown }).ref;
      if (typeof ref !== 'string' || !ref) throw new Error('a ledger event needs a ref');
      if (seen.has(ref)) { skipped++; continue; }
      seen.add(ref);
      push(d as unknown as Record<string, unknown>);
    }
    const added = out.length - (cur.events.length ? 0 : 1);
    if (out.length) {
      if (!cur.exists) closeSync(openSync(path, 'a', 0o600));
      appendFileSync(path, `${out.join('\n')}\n`);
    }
    return { added, skipped, head: prev, events: seq };
  });
}
