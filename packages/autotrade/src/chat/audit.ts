// dexterm autotrade chat — the chat audit chain (task-1527, AUTOTRADE-SPEC §8.6).
//
// $DEXTERM_HOME/autotrade/chat/<YYYY-MM-DD>.jsonl (0600, the directory 0700), one hash-chained event per line with
// the run ledger's chain rule (ledger.ts chainHash/verifyChain): editing, dropping or reordering a line breaks the
// chain from there. A restart on the same day continues the day's chain. The run ledger anchors it: the runner
// writes a `chat_audit` event (day file, head hash, event count) when a run starts and when it ends, and
// verifyChatAudit() cross-checks every anchor, so a day file that was truncated past an anchor, or deleted, or
// re-chained after one, no longer verifies. Not caught: lines added after the last anchor that are then cut (the
// tail since the last run ended), and a forger who re-chains both files (neither chain is keyed).
//
// Recorded: every inbound update (update id, sender id, chat id, the command or the action's proposal id; free text
//   as length + hash only), every outbound message (template id, its fields, the message id), every proposal state
//   change with its hash and the nonce HASH, every verification step with its result.
// Never recorded: the bot token (every line passes redact() as a last net), keys, raw nonces, balances.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GENESIS, chainHash, readLedgerFile, runsDir, verifyChain, type ChainCheck } from '../ledger.ts';
import { redact } from './redact.ts';

export const chatDir = (home: string): string => join(home, 'autotrade', 'chat');

/** Local calendar day, YYYY-MM-DD. */
export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface ChatAuditEvent { seq: number; t: number; kind: string; [k: string]: unknown }

/** Keys that must never be written, whatever a caller passes (defence in depth; nothing passes them on purpose). */
const FORBIDDEN = /^(token|botToken|nonce|secret|key|privateKey|seed|balance|balances)$/i;

export class ChatAudit {
  private readonly home: string | null;
  private day = '';
  private prev = GENESIS;
  private seq = 0;
  private readonly known: () => string | null;
  /** In-memory copy (tests, and the home-less audit of a dry run). */
  readonly events: ChatAuditEvent[] = [];

  /** home = null keeps the chain in memory only. `knownToken` lets the redactor also catch the exact token. */
  constructor(home: string | null, o: { knownToken?: () => string | null } = {}) {
    this.home = home;
    this.known = o.knownToken ?? (() => null);
  }

  file(day = this.day): string | null { return this.home ? join(chatDir(this.home), `${day}.jsonl`) : null; }

  private roll(t: number): void {
    const day = localDay(t);
    if (day === this.day) return;
    this.day = day;
    this.prev = GENESIS;
    this.seq = 0;
    const f = this.file(day);
    if (!f) return;
    mkdirSync(chatDir(this.home!), { recursive: true, mode: 0o700 });
    if (!existsSync(f)) { closeSync(openSync(f, 'a', 0o600)); return; }
    // Continue today's chain from its last line.
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
    const last = lines.length ? (JSON.parse(lines[lines.length - 1]) as ChatAuditEvent) : null;
    if (last && typeof last.hash === 'string' && typeof last.seq === 'number') { this.prev = last.hash; this.seq = last.seq; }
  }

  add(t: number, kind: string, data: Record<string, unknown> = {}): ChatAuditEvent {
    this.roll(t);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) if (!FORBIDDEN.test(k) && v !== undefined) clean[k] = v;
    // The redactor runs over the serialized body; a value that changed is stored redacted (the hash covers that).
    const body = JSON.parse(redact(JSON.stringify(clean), this.known())) as Record<string, unknown>;
    const e: ChatAuditEvent = { ...body, seq: this.seq + 1, t, kind };
    delete e.prev; delete e.hash;
    const h = chainHash(this.prev, e);
    e.prev = this.prev; e.hash = h;
    this.prev = h; this.seq = e.seq;
    this.events.push(e);
    const f = this.file();
    if (f) appendFileSync(f, `${JSON.stringify(e)}\n`);
    return e;
  }

  head(): { day: string; head: string; events: number; file: string | null } { return { day: this.day, head: this.prev, events: this.seq, file: this.file() ? `${this.day}.jsonl` : null }; }
}

export interface ChatAuditCheck { day: string; file: string; check: ChainCheck }

/** A run ledger's record of the chat audit at one moment (written by the runner at run start and end). */
export interface ChatAuditAnchor { runId: string; day: string; head: string; events: number }

/** Every `chat_audit` anchor in the run ledgers under this home (an unreadable ledger is skipped). */
export function chatAuditAnchors(home: string): ChatAuditAnchor[] {
  const dir = runsDir(home);
  if (!existsSync(dir)) return [];
  const out: ChatAuditAnchor[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !x.endsWith('.stream.jsonl')).sort()) {
    let events: Record<string, unknown>[];
    try { events = readLedgerFile(join(dir, f)) as unknown as Record<string, unknown>[]; } catch { continue; }
    for (const e of events) {
      if (e.kind !== 'chat_audit' || typeof e.day !== 'string' || typeof e.head !== 'string' || typeof e.events !== 'number') continue;
      out.push({ runId: f.slice(0, -'.jsonl'.length), day: e.day, head: e.head, events: e.events });
    }
  }
  return out;
}

/** Verify every chat audit day file (or one day): its own chain, then every run-ledger anchor that names it. */
export function verifyChatAudit(home: string, day?: string): ChatAuditCheck[] {
  const dir = chatDir(home);
  const anchors = chatAuditAnchors(home).filter((a) => !day || a.day === day);
  const onDisk = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)) : [];
  const days = [...new Set([...onDisk, ...anchors.map((a) => a.day)])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && (!day || d === day)).sort();
  return days.map((d) => {
    const file = join(dir, `${d}.jsonl`);
    const mine = anchors.filter((a) => a.day === d);
    if (!onDisk.includes(d)) return { day: d, file, check: { ok: false as const, events: 0, at: 0, error: `missing: run ${mine[0]!.runId} anchored ${mine[0]!.events} events in it` } };
    let events: Record<string, unknown>[];
    try { events = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>); } catch (e) {
      return { day: d, file, check: { ok: false as const, events: 0, at: 0, error: `cannot read: ${(e as Error).message.slice(0, 120)}` } };
    }
    const check = verifyChain(events);
    if (!check.ok) return { day: d, file, check };
    for (const a of mine) {
      const at = events.find((e) => e.seq === a.events);
      if (!at) return { day: d, file, check: { ok: false as const, events: events.length, at: events.length, error: `truncated: run ${a.runId} anchored ${a.events} events, the file has ${events.length}` } };
      if (at.hash !== a.head) return { day: d, file, check: { ok: false as const, events: events.length, at: a.events, error: `rewritten: event ${a.events} does not match the head run ${a.runId} anchored` } };
    }
    return { day: d, file, check };
  });
}
