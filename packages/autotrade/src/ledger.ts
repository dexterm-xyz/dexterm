// dexterm autotrade — the run ledger (task-1505 AT-3, AUTOTRADE-SPEC §4, §6.4).
//
// Every step of a run is one hash-chained event: the tick, the message text sent, the raw reply, the parsed
// decision, the clamp request and result, fills, wakes, no-answers, halts and session costs. Each event's hash
// covers the previous hash plus the canonical event, so editing, dropping or reordering any line breaks the chain
// from that line on (`verifyChain`).
//
// A real run (`dexterm autotrade run`) appends each event as one JSON line to
// $DEXTERM_HOME/autotrade/runs/<runId>.jsonl (0600) as it happens, and writes <runId>.summary.json at the end
// (and on every heartbeat, so a crash leaves a current summary). Backtests keep the ledger in memory.
//
// What never goes in: keys, tokens, environment variables. The session layer logs the names of the account kind
// and of the init event's apiKeySource only; account.ts hands a token to `claude` on a file descriptor and to
// nothing else.

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from './strategy.ts';

export interface LedgerEvent { seq: number; t: number; kind: string; [k: string]: unknown }

export const GENESIS = '0'.repeat(16);

/** The chain step (exported for the chat audit chain, task-1527, which uses the same rule). */
export function chainHash(prev: string, e: Record<string, unknown>): string {
  // canonical() drops `hash` keys and undefined values, so the stored line (JSON drops undefined too) re-hashes
  // to the same value; `prev` is added after hashing and excluded here.
  const { prev: _p, ...body } = e;
  return createHash('sha256').update(prev + canonical(body)).digest('hex').slice(0, 16);
}

export class Ledger {
  readonly events: LedgerEvent[] = [];
  private prev = GENESIS;
  private readonly sink?: (e: LedgerEvent, line: string) => void;
  constructor(sink?: (e: LedgerEvent, line: string) => void) { this.sink = sink; }
  add(t: number, kind: string, data: Record<string, unknown> = {}): LedgerEvent {
    // seq / t / kind are the engine's: a data field of the same name can never overwrite them (task-1498 found a
    // `kind` field in a session payload replacing the ledger kind).
    const e: LedgerEvent = { ...data, seq: this.events.length + 1, t, kind };
    delete e.prev; delete e.hash;
    const h = chainHash(this.prev, e);
    e.prev = this.prev; e.hash = h; this.prev = h;
    this.events.push(e);
    this.sink?.(e, JSON.stringify(e));
    return e;
  }
  head(): string { return this.prev; }
}

export type ChainCheck = { ok: true; events: number; head: string } | { ok: false; events: number; at: number; error: string };

/** Recompute the chain: every event's prev is the previous hash, every hash matches its content, seq runs 1..n. */
export function verifyChain(events: readonly Record<string, unknown>[]): ChainCheck {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1) return { ok: false, events: events.length, at: i + 1, error: `seq ${String(e.seq)} where ${i + 1} was expected` };
    if (e.prev !== prev) return { ok: false, events: events.length, at: i + 1, error: 'prev does not match the previous hash (a line was removed, added or reordered)' };
    const want = chainHash(prev, { ...e, hash: undefined });
    if (e.hash !== want) return { ok: false, events: events.length, at: i + 1, error: 'hash does not match the content (the line was edited)' };
    prev = want;
  }
  return { ok: true, events: events.length, head: prev };
}

// ───────────────────────────── files ─────────────────────────────

export const runsDir = (home: string): string => join(home, 'autotrade', 'runs');

/** `20261021T055501Z-moonbag-3fa2`: sortable by start time, unique per start. */
export function newRunId(strategyId: string, now = Date.now(), rand = randomBytes(2).toString('hex')): string {
  const ts = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `${ts}-${strategyId}-${rand}`;
}

export interface RunFiles { runId: string; ledger: string; summary: string }

export function runFiles(home: string, runId: string): RunFiles {
  if (!/^[0-9TZ]+-[a-z][a-z0-9-]{1,31}-[0-9a-f]{4}$/.test(runId)) throw new Error(`not a run id: ${JSON.stringify(runId)}`);
  const dir = runsDir(home);
  return { runId, ledger: join(dir, `${runId}.jsonl`), summary: join(dir, `${runId}.summary.json`) };
}

/**
 * A Ledger whose every event is appended to runs/<runId>.jsonl as it happens (0600, the directory 0700). `tap` sees
 * each event after it is written (task-1527: the chat notify bus); a tap that throws never stops the ledger.
 */
export function fileLedger(home: string, runId: string, tap?: (e: LedgerEvent) => void): { ledger: Ledger; files: RunFiles } {
  const files = runFiles(home, runId);
  mkdirSync(runsDir(home), { recursive: true, mode: 0o700 });
  if (existsSync(files.ledger)) throw new Error(`run ledger ${files.ledger} already exists`);
  closeSync(openSync(files.ledger, 'a', 0o600));
  const ledger = new Ledger((e, line) => { appendFileSync(files.ledger, `${line}\n`); if (tap) { try { tap(e); } catch { /* never the ledger's problem */ } } });
  return { ledger, files };
}

export function readLedgerFile(path: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) if (line.trim()) out.push(JSON.parse(line) as LedgerEvent);
  return out;
}

export const RUN_SUMMARY_SCHEMA = 'dexterm-autotrade-run-summary/1';

/** Atomic write (tmp + rename) of a JSON document, 0600. */
export function writeJsonAtomic(path: string, doc: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
