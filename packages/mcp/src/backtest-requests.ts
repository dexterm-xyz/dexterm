// @dexterm/mcp — BACKTEST REQUESTS (task-1530): an agent PROPOSES a longer backtest; the user runs it.
//
// `strategy_backtest` (task-1507) runs at most 14 days inline and is rate-limited per server. A bigger question
// ("run moonbag over the last 45 days, every candidate") is the user's machine time, so the agent only files a
// request: `backtest_request` writes `$DEXTERM_HOME/autotrade/requests/<br_…>.json` (status pending). Nothing runs
// until the user types `dexterm autotrade requests run <requestId>` (or dismisses it); the result line is then
// written back into the same file, where `backtest_requests` lets the agent read it.
//
// A request can name only a stored strategy id and a day count. It can never change a strategy, a cap or a mode,
// and the run is the ordinary read-only backtest on the recorder history.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const BACKTEST_REQUEST_SCHEMA = 'dexterm-backtest-request/1';
export const REQUEST_MAX_DAYS = 60;
export const MAX_PENDING_REQUESTS = 10;
/** Requests per hour per server process (a request is cheap, the run is not). */
export const REQUEST_RATE_PER_HOUR = 6;

export type RequestStatus = 'pending' | 'done' | 'failed' | 'dismissed';

export interface BacktestRequest {
  schema: typeof BACKTEST_REQUEST_SCHEMA;
  requestId: string;
  /** The strategy id, and the version + hash it had when the request was filed (the run says if it changed). */
  id: string; version: string | null; strategyHash: string | null;
  days: number;
  everyCandidate: boolean;
  why: string;
  actor: string;
  createdAt: number;
  status: RequestStatus;
  resolvedAt?: number;
  /** One line: the backtest result (net, win rate, drawdown, trades), or why it failed. */
  result?: string;
}

export const isRequestId = (x: unknown): x is string => typeof x === 'string' && /^br_[0-9a-f]{12}$/.test(x);
export const requestsDir = (home: string): string => join(home, 'autotrade', 'requests');

export class BacktestRequests {
  private readonly home: string;
  constructor(home: string) { this.home = home; }

  private dir(): string { return requestsDir(this.home); }
  private path(id: string): string { return join(this.dir(), `${id}.json`); }

  get(id: string): BacktestRequest | null {
    if (!isRequestId(id) || !existsSync(this.path(id))) return null;
    try {
      const r = JSON.parse(readFileSync(this.path(id), 'utf8')) as BacktestRequest;
      return r && r.schema === BACKTEST_REQUEST_SCHEMA && r.requestId === id ? r : null;
    } catch { return null; }
  }

  /** Newest first. */
  list(o: { status?: RequestStatus } = {}): BacktestRequest[] {
    if (!existsSync(this.dir())) return [];
    const out: BacktestRequest[] = [];
    for (const f of readdirSync(this.dir())) {
      const m = /^(br_[0-9a-f]{12})\.json$/.exec(f);
      const r = m ? this.get(m[1]) : null;
      if (r && (!o.status || r.status === o.status)) out.push(r);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || a.requestId.localeCompare(b.requestId));
  }

  create(r: Omit<BacktestRequest, 'schema' | 'requestId' | 'status'>): BacktestRequest {
    mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    const rec: BacktestRequest = { schema: BACKTEST_REQUEST_SCHEMA, requestId: `br_${randomBytes(6).toString('hex')}`, status: 'pending', ...r };
    this.write(rec);
    return rec;
  }

  /** The user's side only (`dexterm autotrade requests run|dismiss`): mark a request done / failed / dismissed. */
  resolve(id: string, status: Exclude<RequestStatus, 'pending'>, result: string | null, now = Date.now()): BacktestRequest | null {
    const r = this.get(id);
    if (!r) return null;
    const next: BacktestRequest = { ...r, status, resolvedAt: now, ...(result ? { result: result.slice(0, 400) } : {}) };
    this.write(next);
    return next;
  }

  private write(r: BacktestRequest): void {
    const p = this.path(r.requestId);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, p);
  }
}
