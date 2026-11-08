// dexterm — the STRATEGY overlay scene (task-2170, "watch it cook"). One strategy's PAPER run as it happens: its rules
// in plain words, its open bags (HELD) and the last closed ones (SOLD), its entries and exits from the run ledgers, its
// equity, and which exit-ladder rungs have been hit. Read by `dexterm autotrade watch <id>` (terminal + overlay scene)
// and by the Strategy Builder web UI.
//
// Honesty by construction: every figure is read from the engine's own files (the run ledgers under autotrade/runs via
// readStrategyLedgers, forward tests, the strategy store); nothing is estimated or rounded up. Every view carries the
// PAPER · SIMULATED stamp and the age of its newest ledger line. Mints are masked (head…tail); symbols and reasons are
// untrusted text (cleaned to one printable line). No writes, no control surface.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  listForwardTests, liveState, memberFor, runsDir, strategyOverview,
  type ExitProfile, type ResolvedStrategy, type StrategyStore,
} from '@dexterm/autotrade';
import { equityCurve, readStrategyLedgers } from '@dexterm/autotrade/strategy-stats';
import { maskAddress } from '@dexterm/agents';

export const STRATEGY_STAMP = 'PAPER · SIMULATED';
const BAGS_MAX = 10;
const EVENTS_MAX = 14;
const FILES_MAX = 40;
const FILE_BYTES_MAX = 8 * 1024 * 1024;

/** One printable line of untrusted text, bounded. */
export function inert(s: unknown, max = 80): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const usd = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x: number): string => `${x > 0 ? '+' : ''}${x}%`;
const capUsd = (x: number): string => (x >= 1e9 ? `$${+(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${+(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${+(x / 1e3).toFixed(1)}K` : `$${x}`);

// ───────────────────────────── rules in plain words ─────────────────────────────

function profileWords(p: ExitProfile): string[] {
  const out: string[] = [];
  const sold = p.tpLadder.reduce((s, t) => s + t.sellFrac, 0);
  if (p.tpLadder.length) {
    out.push(`take profit: ${p.tpLadder.map((t) => `${t.atMcapUsd !== undefined ? `at ${capUsd(t.atMcapUsd)} market cap` : `at +${t.atPct}%`} sell ${Math.round(t.sellFrac * 1000) / 10}%`).join(' · ')}`);
  }
  const moon = Math.round((1 - sold) * 1000) / 10;
  if (moon > 0) out.push(`moonbag: ${moon}% of the bag rides after the ladder${p.bagTrail ? `, trailed ${p.bagTrail.trailPct}% off its peak` : p.trailingStop ? `, trailed ${p.trailingStop.trailPct}% once up ${p.trailingStop.armAtPct}%` : ''}`);
  if (p.costRecovery) out.push(`cost recovery: at +${p.costRecovery.atPct}% sell enough to pay back the cost (at most ${Math.round(p.costRecovery.maxSellFrac * 100)}%)`);
  if (p.trailingStop) out.push(`trailing stop: arms at +${p.trailingStop.armAtPct}%, trails ${p.trailingStop.trailPct}%`);
  if (p.hardStop.enabled && p.hardStop.atPct !== null) out.push(`hard stop: ${p.hardStop.atPct}%`);
  if (p.timeStop) out.push(`time stop: after ${p.timeStop.minutes} min below ${pct(p.timeStop.ifBelowPct)}: ${p.timeStop.action}`);
  return out;
}

/** The strategy's rules in plain words (entry gates, sizing, exits per profile, caps). */
export function rulesInWords(s: ResolvedStrategy): { entry: string[]; sizing: string[]; exits: Array<{ profile: string; lines: string[] }>; caps: string[] } {
  const e = s.entry;
  const entry = [
    `screen: ${inert(e.screen, 200) || '(any coin)'}`,
    `pool age: ${e.ageHours.min} h${e.ageHours.max === null ? ' or older' : ` to ${e.ageHours.max} h`}`,
  ];
  const sf = e.safety;
  const gates = [
    sf.maxTop10Pct !== null ? `top 10 holders at most ${sf.maxTop10Pct}%` : '',
    sf.maxDevPct !== null ? `dev at most ${sf.maxDevPct}%` : '',
    sf.requireNoMintAuthority ? 'no mint authority' : '',
    sf.requireNoFreezeAuthority ? 'no freeze authority' : '',
    sf.youngVertical ? `skip coins under ${sf.youngVertical.maxAgeHours} h already up ${sf.youngVertical.maxH1Pct}% on the hour` : '',
    sf.larp ? `LARP score at most ${sf.larp.maxScore}` : '',
    sf.rugproof ? 'the pool gates' : '',
  ].filter(Boolean);
  if (gates.length) entry.push(`gates: ${gates.join(' · ')}`);
  if (e.triggers.length) entry.push(`triggers (${e.triggerMode}): ${e.triggers.map((t) => inert(typeof t === 'string' ? t : (t as { kind?: string }).kind ?? JSON.stringify(t), 60)).join(' · ')}`);
  entry.push(`decides: ${e.decide === 'auto' ? 'mechanical entry' : e.decide === 'agent+approve' ? 'your Claude decides, each entry waits for your tap' : 'your Claude decides each candidate'}`);
  const z = s.sizing;
  const sizing = [
    `size: ${z.mode === 'fixed' && fin(z.fixedUsd) ? `${usd(z.fixedUsd)} a trade` : z.mode === 'pct' && fin(z.pct) ? `${z.pct}% of the paper book` : z.mode === 'risk' && fin(z.riskPct) ? `risk ${z.riskPct}% of the book to the stop` : z.mode}`,
    `clamp: ${usd(z.minUsd)} to ${usd(z.maxUsd)}, at most ${z.maxPctOfBankroll}% of the book`,
    `paper book: ${usd(s.bankroll.startUsd)}`,
  ];
  const exits = Object.values(s.exits.profiles).map((p) => ({ profile: inert(p.id, 32), lines: profileWords(p) }));
  const r = s.risk;
  const caps = [
    `at most ${r.maxConcurrent} open · ${r.maxEntriesPerDay} entries a day · ${r.perCoin.maxEntries} per coin`,
    `exposure at most ${r.maxExposurePct}% · daily loss halt ${r.dailyLossHaltPct}% · drawdown halt ${r.drawdown.haltAtPct}%`,
  ];
  return { entry, sizing, exits, caps };
}

/** The ladder rungs of every profile, as labels a sell's reason is matched against (`tp<N>`). */
export function ladderRungs(s: ResolvedStrategy): Array<{ key: string; label: string; profile: string }> {
  const out: Array<{ key: string; label: string; profile: string }> = [];
  for (const p of Object.values(s.exits.profiles)) {
    p.tpLadder.forEach((t, i) => out.push({ key: `${p.id}:tp${i + 1}`, profile: p.id, label: `${t.atMcapUsd !== undefined ? capUsd(t.atMcapUsd) : `+${t.atPct}%`} · sell ${Math.round(t.sellFrac * 100)}%` }));
    if (p.costRecovery) out.push({ key: `${p.id}:cost-recovery`, profile: p.id, label: `cost back at +${p.costRecovery.atPct}%` });
    if (p.bagTrail) out.push({ key: `${p.id}:bag-trail`, profile: p.id, label: `moonbag trail ${p.bagTrail.trailPct}%` });
  }
  return out;
}

// ───────────────────────────── the run ledgers ─────────────────────────────

export interface CookFill { t: number; side: 'buy' | 'sell'; symbol: string; mint: string; usd: number | null; reason: string; profile: string | null }

/** The newest fills of one strategy (member) from the run ledgers, newest first. Bounded reads. */
export function readStrategyFills(home: string, ids: string[], max = EVENTS_MAX): CookFill[] {
  const dir = runsDir(home);
  if (!existsSync(dir)) return [];
  let files: Array<{ f: string; m: number }>;
  try { files = readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !/-fleet-/.test(x)).map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })); } catch { return []; }
  files.sort((a, b) => b.m - a.m);
  const out: CookFill[] = [];
  const symbols = new Map<string, string>();
  for (const { f } of files.slice(0, FILES_MAX)) {
    let text: string;
    try { if (statSync(join(dir, f)).size > FILE_BYTES_MAX) continue; text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    let member: string | null = null;
    const mine: CookFill[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.kind === 'fleet_member' || e.kind === 'run_start') { member ??= (e.member ?? e.strategy ?? null) as string | null; continue; }
      if (!member || !ids.includes(member)) break;
      if (e.kind === 'candidate' && typeof e.mint === 'string' && typeof e.symbol === 'string') symbols.set(e.mint, e.symbol);
      if (e.kind !== 'fill' || !fin(e.t) || (e.side !== 'buy' && e.side !== 'sell')) continue;
      const mint = typeof e.mint === 'string' ? e.mint : '';
      mine.push({ t: e.t, side: e.side, mint: mint ? maskAddress(mint) : '?', symbol: inert(symbols.get(mint) ?? '', 16), usd: fin(e.usd) ? Math.round(e.usd * 100) / 100 : null, reason: inert(e.reason, 40), profile: typeof e.profile === 'string' ? inert(e.profile, 32) : null });
    }
    out.push(...mine);
  }
  return out.sort((a, b) => b.t - a.t).slice(0, max);
}

// ───────────────────────────── the scene view ─────────────────────────────

export interface StrategyBag { state: 'HELD' | 'SOLD'; symbol: string; mint: string; costUsd: number | null; pnlUsd: number | null; pnlPct: number | null; exitReason: string | null; at: number | null }
export interface StrategyOverlayView {
  scene: 'strategy';
  stamp: string;
  sample: boolean;
  age: string;
  ageSec: number | null;
  id: string;
  name: string;
  stage: string;
  generated: boolean;
  source: string;
  attached: string | null;
  rules: ReturnType<typeof rulesInWords> | null;
  equity: { startUsd: number | null; endUsd: number | null; netUsd: number | null; closed: number; open: number; entries: number; points: number[] };
  bags: StrategyBag[];
  events: Array<CookFill & { when: string }>;
  rungs: Array<{ label: string; profile: string; hits: number }>;
  note: string;
}

const ago = (now: number, t: number | null): string => {
  if (t === null) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

export interface StrategyCookInput { home: string; store: StrategyStore; id: string; now?: number; sample?: boolean; attached?: string | null }

/** Everything the strategy scene shows, read from disk now. Throws nothing: an unreadable piece shows as empty. */
export function strategyOverlayView(o: StrategyCookInput): StrategyOverlayView {
  const now = o.now ?? Date.now();
  const got = o.store.get(o.id);
  const s = got && got.ok ? got.strategy : null;
  let row: ReturnType<typeof strategyOverview>[number] | undefined;
  try { row = strategyOverview(o.home, o.store).find((r) => r.id === o.id); } catch { row = undefined; }
  const member = memberFor(o.home, o.id);
  const ids = [...new Set([o.id, ...(member?.id ? [String(member.id)] : [])])];
  let ledger: ReturnType<typeof readStrategyLedgers>[string] | undefined;
  try { const all = readStrategyLedgers(runsDir(o.home), { now }); ledger = ids.map((k) => all[k]).find(Boolean); } catch { ledger = undefined; }
  const fills = readStrategyFills(o.home, ids);
  let fw: ReturnType<typeof listForwardTests>[number] | undefined;
  try { fw = listForwardTests(o.home, { strategyId: o.id }).sort((a, b) => b.createdAt - a.createdAt)[0]; } catch { fw = undefined; }
  const fwState = fw ? liveState(fw, now) : null;
  const source = fw && (fwState === 'running' || fwState === 'starting') ? `paper forward test ${fw.forwardId} (${fwState})`
    : row?.running ? `always-on paper run (${row.running})`
    : ledger ? 'paper run ledgers (not running now)' : 'not running: start a paper forward test from the Builder';
  const closed = ledger?.closed ?? [];
  const eq = ledger ? equityCurve(closed, ledger.startUsd) : null;
  const bags: StrategyBag[] = [
    ...(ledger?.openPositions ?? []).map((p): StrategyBag => ({ state: 'HELD', symbol: inert(p.symbol ?? '', 16), mint: p.mint ? maskAddress(p.mint) : '?', costUsd: fin(p.costUsd) ? Math.round(p.costUsd * 100) / 100 : null, pnlUsd: null, pnlPct: null, exitReason: null, at: p.openedAt })),
    ...closed.slice(-BAGS_MAX).reverse().map((c): StrategyBag => ({ state: 'SOLD', symbol: inert(c.symbol ?? '', 16), mint: c.mint ? maskAddress(c.mint) : '?', costUsd: c.costUsd, pnlUsd: c.pnlUsd, pnlPct: c.pnlPct, exitReason: c.exitReason ? inert(c.exitReason, 40) : null, at: c.t })),
  ].slice(0, BAGS_MAX);
  const hits = new Map<string, number>();
  for (const f of fills) if (f.side === 'sell') { const k = `${f.profile ?? ''}:${f.reason}`; hits.set(k, (hits.get(k) ?? 0) + 1); }
  const rungs = s ? ladderRungs(s).map((r) => ({ label: r.label, profile: r.profile, hits: hits.get(r.key) ?? 0 })) : [];
  const lastT = Math.max(ledger?.lastT ?? 0, fills[0]?.t ?? 0) || null;
  const ageSec = lastT === null ? null : Math.max(0, Math.round((now - lastT) / 1000));
  return {
    scene: 'strategy', stamp: STRATEGY_STAMP, sample: !!o.sample,
    age: lastT === null ? 'no paper fills yet' : `last ledger line ${ago(now, lastT)} ago`, ageSec,
    id: o.id, name: inert(s?.name ?? row?.name ?? o.id, 60), stage: row?.stage ?? (s ? 'draft' : 'invalid'), generated: row?.source === 'generated',
    source, attached: o.attached ?? null, rules: s ? rulesInWords(s) : null,
    equity: {
      startUsd: ledger?.startUsd ?? null, endUsd: eq ? Math.round(eq.end * 100) / 100 : null, netUsd: eq && ledger?.startUsd !== null && ledger?.startUsd !== undefined ? Math.round((eq.end - eq.start) * 100) / 100 : null,
      closed: closed.length, open: ledger?.open ?? 0, entries: ledger?.entries ?? 0, points: eq ? eq.points.slice(-120).map((p) => Math.round(p.usd * 100) / 100) : [],
    },
    bags, events: fills.map((f) => ({ ...f, when: ago(now, f.t) })), rungs,
    note: s ? 'paper results are simulated · a strategy is a set of rules, not an edge · dexterm places no orders' : got && !got.ok ? `${o.id} does not validate` : `no strategy ${o.id}`,
  };
}

/** The scene as terminal lines (the watch window), width-bounded. */
export function strategyOverlayLines(v: StrategyOverlayView, width = 100): string[] {
  const w = Math.max(40, width);
  const cut = (s: string): string => (s.length > w ? s.slice(0, w - 1) + '…' : s);
  const out: string[] = [];
  out.push(cut(`◆ dexterm · WATCH IT COOK · ${v.name} (${v.id}) · ${v.stage}${v.generated ? ' · GENERATED' : ''} · ${v.stamp}`));
  out.push(cut(`  ${v.source} · ${v.age}${v.attached ? ` · ${v.attached}` : ''}`));
  out.push('');
  if (v.rules) {
    out.push('RULES');
    for (const l of [...v.rules.entry, ...v.rules.sizing]) out.push(cut(`  ${l}`));
    for (const x of v.rules.exits) for (const l of x.lines) out.push(cut(`  [${x.profile}] ${l}`));
    out.push('');
  }
  const e = v.equity;
  out.push(cut(`EQUITY (paper)  ${e.startUsd !== null ? `start ${usd(e.startUsd)}` : 'no book yet'}${e.endUsd !== null ? ` · now ${usd(e.endUsd)}` : ''}${e.netUsd !== null ? ` · net ${usd(e.netUsd)}` : ''} · ${e.entries} entries · ${e.closed} closed · ${e.open} open`));
  out.push('');
  out.push('BAGS');
  if (!v.bags.length) out.push('  none yet');
  for (const b of v.bags) out.push(cut(`  ${b.state.padEnd(4)}  ${(b.symbol ? `$${b.symbol}` : '').padEnd(12)} ${b.mint.padEnd(10)} ${b.costUsd !== null ? `cost ${usd(b.costUsd)}` : ''}${b.pnlPct !== null ? `  ${pct(b.pnlPct)}` : ''}${b.exitReason ? `  (${b.exitReason})` : ''}`));
  out.push('');
  out.push('LADDER RUNGS HIT');
  if (!v.rungs.length) out.push('  no ladder');
  for (const r of v.rungs) out.push(cut(`  ${r.hits ? '●' : '○'} [${r.profile}] ${r.label}${r.hits ? `  × ${r.hits}` : ''}`));
  out.push('');
  out.push('ENTRIES AND EXITS');
  if (!v.events.length) out.push('  no paper fills yet');
  for (const f of v.events) out.push(cut(`  ${f.when.padStart(4)}  ${f.side === 'buy' ? 'ENTRY' : 'EXIT '} ${(f.symbol ? `$${f.symbol}` : '').padEnd(12)} ${f.mint.padEnd(10)} ${f.usd !== null ? usd(f.usd) : ''}  ${f.reason}`));
  out.push('');
  out.push(cut(`  ${v.note}`));
  return out;
}
