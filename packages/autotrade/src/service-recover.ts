// dexterm autotrade — safe resume after a crash or a reboot (0.2.0 card B, AUTOTRADE-SPEC §7.4 "Restart safety").
//
// The service records the fleet it hosts in service/state.json. When the next start finds that fleet without a
// `fleet_end` (a crash, a kill -9, a power cut), recoverFleet() reads the fleet ledger for each strategy's runs and,
// for every member run without a `run_end`:
//   - checks its hash chain (a torn last line from a crash mid-write is dropped first and reported);
//   - rebuilds the paper positions still open from the run's own events: `position_adopted` snapshots (an earlier
//     resume) plus every `fill` of that position, minus the positions a `trade_closed` closed;
//   - collects every coin the run took (any buy, any adopted position, an earlier resume's taken list).
// The new run of the same strategy ADOPTS those positions (their exits keep running: stops, take-profits, trails,
// max hold from the original open time) and REFUSES a new entry on every taken coin (vet rule
// `service-resume-taken`), so a restart never buys a coin twice.
//
// Conservative choices, all in the direction of selling sooner and buying never:
//   - an order still pending at the crash had no fill event, so it never happened: it is never re-sent;
//   - an adopted position keeps no unfilled ladder tranche (no add after a restart) and its peak is the highest
//     fill price (a trail measures from at most that);
//   - a run whose chain is broken (an edited ledger) adopts nothing; its coins still count as taken.
// Mode-agnostic: a paper position is adopted into the paper book; a real-mode position (card A) is the user's
// executor's, and the same taken list keeps the next run from firing a second entry signal for it.

import { existsSync, readFileSync } from 'node:fs';
import type { Fill, Position } from './engine.ts';
import { runFiles, verifyChain, type LedgerEvent } from './ledger.ts';
import type { MarketTick } from './replay.ts';

export const RESUME_TAKEN_RULE = 'service-resume-taken';

export interface MemberRecovery {
  member: string;
  /** The crashed runs of this strategy (normally one). */
  runIds: string[];
  positions: Position[];
  /** Every coin those runs took (open or closed). */
  taken: string[];
  problems: string[];
}

export interface FleetRecovery {
  fleetId: string;
  /** false: the fleet ended cleanly (or never started); nothing to resume. */
  crashed: boolean;
  members: MemberRecovery[];
  problems: string[];
}

/** Read a ledger file tolerating a torn final line (a crash mid-append); any other bad line is an error. */
export function readLedgerTolerant(path: string): { events: LedgerEvent[]; torn: boolean } {
  const lines = readFileSync(path, 'utf8').split('\n');
  const events: LedgerEvent[] = [];
  let torn = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as LedgerEvent); } catch (e) {
      const rest = lines.slice(i + 1).some((l) => l.trim());
      if (rest) throw new Error(`line ${i + 1} is not JSON: ${(e as Error).message}`);
      torn = true;
    }
  }
  return { events, torn };
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** A placeholder tick at the last known price, until the live feed sends a real one (focus marks the coin held). */
export function placeholderTick(mint: string, symbol: string, t: number, price: number): MarketTick {
  return {
    mint, t, kind: 'live', symbol, launchpad: 'unknown' as MarketTick['launchpad'], createdAt: null, price, mcap: null, mcapResolved: null, mcapFlagged: false,
    liq: null, vol5m: null, vol1h: null, vol24: null, buys5m: null, sells5m: null, buys24: null, sells24: null,
    chg5m: null, chg1h: null, chg6h: null, chg24h: null, holders: null, top10: null, dev: null, mintAuth: null, freezeAuth: null, org: null,
  } as MarketTick;
}

/** Open positions and taken coins from ONE run's events (pure; the run is known to have no run_end). */
export function positionsFromEvents(events: readonly LedgerEvent[]): { positions: Position[]; taken: string[] } {
  const symbols = new Map<string, string>();
  const base = new Map<string, Position>();
  const fills = new Map<string, { mint: string; profile: string | null; fills: Fill[] }>();
  const closed = new Set<string>();
  const taken = new Set<string>();
  for (const e of events) {
    const mint = typeof e.mint === 'string' ? e.mint : null;
    if (e.kind === 'candidate' && mint && typeof e.symbol === 'string') symbols.set(mint, e.symbol);
    else if (e.kind === 'position_adopted' && e.position && typeof e.position === 'object') {
      const p = e.position as Position;
      if (typeof p.id === 'string' && typeof p.mint === 'string') { base.set(p.id, structuredClone(p)); taken.add(p.mint); symbols.set(p.mint, p.symbol); }
    } else if (e.kind === 'fill' && typeof e.positionId === 'string' && mint) {
      const f: Fill = { t: num(e.t), side: e.side === 'sell' ? 'sell' : 'buy', usd: num(e.usd), tokens: num(e.tokens), price: num(e.price), avgPrice: num(e.avgPrice, num(e.price)), impactPct: num(e.impactPct), partial: !!e.partial, reason: String(e.reason ?? '') };
      const cur = fills.get(e.positionId) ?? { mint, profile: null, fills: [] };
      if (typeof e.profile === 'string') cur.profile ??= e.profile;
      cur.fills.push(f);
      fills.set(e.positionId, cur);
      if (f.side === 'buy') taken.add(mint);
    } else if (e.kind === 'trade_closed' && e.trade && typeof e.trade === 'object') {
      const t = e.trade as { id?: unknown; mint?: unknown; symbol?: unknown };
      if (typeof t.id === 'string') closed.add(t.id);
      if (typeof t.mint === 'string' && typeof t.symbol === 'string') symbols.set(t.mint, t.symbol);
    }
  }
  const out: Position[] = [];
  const ids = new Set([...base.keys(), ...fills.keys()]);
  for (const id of ids) {
    if (closed.has(id)) continue;
    const b = base.get(id);
    const f = fills.get(id);
    const mint = b?.mint ?? f!.mint;
    const symbol = symbols.get(mint) ?? b?.symbol ?? `${mint.slice(0, 4)}…`;
    const p: Position = b ?? {
      id, mint, symbol, profileId: f?.profile ?? 'default', openedAt: f!.fills[0].t, sessionId: null,
      tokens: 0, origTokens: 0, costUsd: 0, realizedUsd: 0, entryPrice: 0, peakPrice: 0, tpFilled: 0, trailArmed: false,
      ladder: [], fills: [], status: 'open', stuck: false, closedAt: null, exitReason: null, liqWindow: [], lowTapeSince: null,
      lastTick: placeholderTick(mint, symbol, f!.fills[0].t, f!.fills[0].price), wakeSent: {},
    };
    for (const x of f?.fills ?? []) {
      if (x.side === 'buy') {
        const tokens = p.tokens + x.tokens;
        p.entryPrice = tokens > 0 ? (p.entryPrice * p.tokens + x.price * x.tokens) / tokens : x.price;
        p.tokens = tokens; p.origTokens += x.tokens; p.costUsd += x.usd;
      } else {
        p.tokens = Math.max(0, p.tokens - x.tokens);
        p.realizedUsd += x.usd;
        const tp = /^tp(\d+)$/.exec(x.reason);
        if (tp) p.tpFilled = Math.max(p.tpFilled, Number(tp[1]));
        if (x.reason === 'cost-recovery') p.costRecovered = true;
      }
      p.peakPrice = Math.max(p.peakPrice, x.price);
      p.fills.push(x);
    }
    if (p.origTokens > 0 && p.tokens < p.origTokens * 1e-6) continue; // sold out without a trade_closed line (torn)
    if (!(p.tokens > 0)) continue;
    const last = p.fills[p.fills.length - 1];
    p.ladder = [];
    p.sessionId = null;
    p.status = 'open';
    p.troughPrice = p.troughPrice ?? Math.min(...p.fills.map((x) => x.price));
    if (last) p.lastTick = placeholderTick(mint, p.symbol || symbol, last.t, last.price);
    p.symbol = p.symbol || symbol;
    out.push(p);
  }
  return { positions: out, taken: [...taken] };
}

/** What the crashed fleet left behind, per strategy (empty when it ended cleanly). */
export function recoverFleet(home: string, fleetId: string): FleetRecovery {
  const res: FleetRecovery = { fleetId, crashed: false, members: [], problems: [] };
  let fpath: string;
  try { fpath = runFiles(home, fleetId).ledger; } catch (e) { res.problems.push((e as Error).message); return res; }
  if (!existsSync(fpath)) { res.problems.push(`no fleet ledger for ${fleetId}`); return res; }
  let fleet: LedgerEvent[];
  try { fleet = readLedgerTolerant(fpath).events; } catch (e) { res.problems.push(`fleet ledger: ${(e as Error).message}`); return res; }
  if (fleet.some((e) => e.kind === 'fleet_end')) return res;
  res.crashed = true;
  const runsOf = new Map<string, string[]>();
  for (const e of fleet) if (e.kind === 'member_start' && typeof e.member === 'string' && typeof e.runId === 'string') runsOf.set(e.member, [...(runsOf.get(e.member) ?? []), e.runId]);
  // An earlier resume's taken coins (the service writes them into the fleet ledger), so a second crash keeps them.
  const takenBefore = new Map<string, string[]>();
  for (const e of fleet) {
    if (e.kind !== 'service_resume' || !e.members || typeof e.members !== 'object') continue;
    for (const [id, v] of Object.entries(e.members as Record<string, { taken?: unknown }>)) {
      if (Array.isArray(v?.taken)) takenBefore.set(id, [...(takenBefore.get(id) ?? []), ...v.taken.filter((x): x is string => typeof x === 'string')]);
    }
  }
  for (const id of takenBefore.keys()) if (!runsOf.has(id)) runsOf.set(id, []);
  for (const [member, runIds] of runsOf) {
    const m: MemberRecovery = { member, runIds: [], positions: [], taken: [], problems: [] };
    const taken = new Set<string>(takenBefore.get(member) ?? []);
    for (const runId of runIds) {
      let path: string;
      try { path = runFiles(home, runId).ledger; } catch (e) { m.problems.push((e as Error).message); continue; }
      if (!existsSync(path)) continue;
      let ev: { events: LedgerEvent[]; torn: boolean };
      try { ev = readLedgerTolerant(path); } catch (e) { m.problems.push(`${runId}: ${(e as Error).message}; nothing adopted from it`); continue; }
      if (ev.events.some((e) => e.kind === 'run_end')) continue;
      m.runIds.push(runId);
      if (ev.torn) m.problems.push(`${runId}: a torn last line (the crash) was dropped`);
      const r = positionsFromEvents(ev.events);
      for (const t of r.taken) taken.add(t);
      const chain = verifyChain(ev.events);
      if (!chain.ok) { m.problems.push(`${runId}: the hash chain breaks at event ${chain.at} (${chain.error}); nothing adopted from it, its coins stay taken`); continue; }
      // A book numbers its positions p1, p2, …: an adopted one keeps its origin in its id so it never collides with
      // the new run's own (an id that already names a run came from an earlier resume).
      for (const p of r.positions) if (!p.id.includes('/')) p.id = `${runId}/${p.id}`;
      m.positions.push(...r.positions);
    }
    m.taken = [...taken];
    if (m.runIds.length || m.problems.length || m.taken.length) res.members.push(m);
  }
  return res;
}
