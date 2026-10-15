// `dexterm follow …` — the copy-trading follow list from a shell (task-1360 Tier 1).
//
//   dexterm follow add <addr> [--name LABEL]     follow a wallet (label = your own words, firewalled, local only)
//   dexterm follow remove <addr>
//   dexterm follow list [--json]
//   dexterm follow stats <addr> [--json]         one history fetch (Helius, 10 credits): trades, FIFO PnL, win rate (n)
//   dexterm follow trades <addr> [--limit N]     the decoded swaps behind the stats
//   dexterm follow purge --yes                   delete every follow and label (the local label store is deletable)
//   dexterm follow auto <addr> [--per-trade USD] [--daily USD] [--max-open N] [--cooldown SEC] [--k X] [--disarm N]
//                                               draft the auto-mirror caps (clamped down to the hard ceilings; auto stays OFF —
//                                               enabling is a keypress in the app after the less-safe popup) · --off turns it off
//   dexterm follow auto                          list the auto policies and their state
//
// Self-directed only: your list, your wallet, your keys. Nothing here trades, proposes or signs; `stats` needs a free
// Helius key (keyless prints the fix) and reads public history. Secrets never print: the RPC URL stays inside the
// data layer.

import { createDataLayer, resolveRpcUrl, HeliusHistory, type DataLayer } from '@dexterm/data';
import { FollowStore, WalletTracker, defaultFollowsPath, isWalletAddress, shortAddr, CopyAuto, defaultCopyJournalPath, AUTO_HARD, autoSizeCap, type HistorySource, type WalletStats } from '@dexterm/data/copy';
import { PlanService, defaultPlansJournalPath } from '@dexterm/data/plans';
import type { Io } from './main.ts';

export interface FollowCmdOverrides {
  /** Follow-list path (tests use a temp dir); null = in-memory. */
  followsPath?: string | null;
  /** Inject a history source (tests); null = keyless. Default: Helius from the resolved RPC config, if keyed. */
  history?: HistorySource | null;
  solUsd?: number | null;
  /** Auto-policy journal path (tests); null = memory. */
  copyJournalPath?: string | null;
  /** Plans journal path (tests); null = memory. */
  plansJournalPath?: string | null;
}

function flag(rest: string[], name: string): string | undefined { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; }
function has(rest: string[], name: string): boolean { return rest.includes(name); }

const USAGE = `dexterm follow <command>
  add <addr> [--name LABEL]        follow a wallet (your own label, never inferred, local only)
  remove <addr>
  list [--json]
  stats <addr> [--json]            one Helius history fetch: trades, FIFO realised PnL, win rate (hidden under n=10)
  trades <addr> [--limit N]        the decoded swaps behind the stats
  purge --yes                      delete every follow and label
  auto <addr> [--per-trade USD] [--daily USD] [--max-open N] [--cooldown SEC] [--k X] [--disarm N] [--off]
                                   draft the auto-mirror caps (always OFF here: enabling is a keypress in the app, U then A,
                                   after the "less safe" popup) · --off turns a running policy off · no addr = list
self-directed only: your list, your wallet, your keys · nothing here trades or signs`;

function fmtStats(s: WalletStats): string[] {
  const out = [
    `${shortAddr(s.wallet)}  ${s.trades} trades (${s.buys} buys · ${s.sells} sells · ${s.transfers} transfers) over ${s.mints} mints · ${s.sample.note}`,
    `realised ${s.realisedSol >= 0 ? '+' : ''}${s.realisedSol.toFixed(4)} SOL${s.realisedUsd !== null ? ` (${s.realisedUsd >= 0 ? '+' : ''}$${s.realisedUsd.toFixed(2)} at $${s.solUsdAt}/SOL now)` : ' (no SOL price: USD not shown)'} · FIFO over fetched history, fees and tips included`,
    `win rate ${s.winRate === null ? '—' : `${(s.winRate * 100).toFixed(0)}%`} · ${s.winRateNote} · open positions ${s.open}`,
    `early-entry score ${s.earlyEntry.score === null ? '—' : s.earlyEntry.score.toFixed(2)} · ${s.earlyEntry.note}`,
  ];
  for (const p of s.positions.slice(0, 12)) out.push(`  ${shortAddr(p.mint)}  ${p.closed ? 'closed' : 'open  '}  realised ${p.realisedSol >= 0 ? '+' : ''}${p.realisedSol.toFixed(4)} SOL  ${p.buys}b/${p.sells}s${p.flagged ? '  (cost-0 lot: airdrop/transfer/unpriced leg)' : ''}`);
  if (s.positions.length > 12) out.push(`  … ${s.positions.length - 12} more mints`);
  out.push('not a recommendation · a wallet\'s past fills say nothing about its next one');
  return out;
}

export async function runFollow(rest: string[], io: Io, over: FollowCmdOverrides = {}): Promise<number> {
  const cmd = rest[0];
  const out = (s: string) => io.stdout.write(s + '\n');
  const errOut = (s: string) => io.stderr.write(s + '\n');
  const store = new FollowStore({ path: over.followsPath === undefined ? defaultFollowsPath(io.env) : over.followsPath });
  switch (cmd) {
    case 'add': {
      const addr = rest[1];
      if (!addr || addr.startsWith('--')) { errOut('usage: dexterm follow add <addr> [--name LABEL]'); return 2; }
      const r = store.add(addr, flag(rest, '--name'));
      if (!r.ok) { errOut(`dexterm follow add: ${r.reason}`); return 1; }
      out(`following ${shortAddr(r.follow.addr)}${r.follow.name ? ` as "${r.follow.name}"` : ''} · ${store.list().length} followed · alerts show in the app (U)`);
      return 0;
    }
    case 'remove': {
      const addr = rest[1];
      if (!addr) { errOut('usage: dexterm follow remove <addr>'); return 2; }
      out(store.remove(addr) ? `unfollowed ${shortAddr(addr)}` : `${shortAddr(addr)} was not followed`);
      return 0;
    }
    case 'list': {
      const rows = store.list();
      if (has(rest, '--json')) { out(JSON.stringify(rows)); return 0; }
      if (!rows.length) { out('no wallets followed · dexterm follow add <addr> [--name LABEL]'); return 0; }
      for (const f of rows) out(`${f.addr}  ${f.name ?? '—'}  since ${new Date(f.since).toISOString().slice(0, 10)}`);
      return 0;
    }
    case 'auto': {
      const addr = rest[1] && !rest[1].startsWith('--') ? rest[1] : null;
      const plans = new PlanService({ journalPath: over.plansJournalPath === undefined ? defaultPlansJournalPath(io.env) : over.plansJournalPath });
      const auto = new CopyAuto({ plans, journalPath: over.copyJournalPath === undefined ? defaultCopyJournalPath(io.env) : over.copyJournalPath, market: async () => null, isFollowed: (w) => store.has(w) });
      if (!addr) {
        const pols = auto.list();
        if (has(rest, '--json')) { out(JSON.stringify(pols)); return 0; }
        if (!pols.length) { out('no auto-mirror policies · dexterm follow auto <addr> --per-trade 20 --daily 100'); return 0; }
        for (const p of pols) out(`${p.wallet}  ${p.enabled ? 'ON ' : 'off'}  ≤ $${autoSizeCap(p).toFixed(2)}/mirror (¼ of $${Math.min(p.perTradeUsd, p.dailyUsd)})  $${p.dailyUsd}/day  max ${p.maxOpen} open  ${Math.round(p.cooldownMs / 1000)} s cooldown  k=${p.k}  disarm@${p.autoDisarmStreak}${p.offReason ? `  (${p.offReason})` : ''}`);
        out('auto is OFF in every fresh process; enable it in the app: U → A (needs the less-safe popup, G on the O screen)');
        return 0;
      }
      if (!isWalletAddress(addr)) { errOut('usage: dexterm follow auto <addr> [caps…] [--off]'); return 2; }
      if (!store.has(addr)) { errOut(`dexterm follow auto: ${shortAddr(addr)} is not followed (dexterm follow add <addr> first)`); return 1; }
      if (has(rest, '--off')) { const p = auto.disable(addr, 'user (cli)'); out(p ? `auto-mirror off for ${shortAddr(addr)}` : 'no policy for that wallet'); return 0; }
      const sec = flag(rest, '--cooldown');
      try {
        const p = auto.draft(addr, {
          perTradeUsd: flag(rest, '--per-trade') ? Number(flag(rest, '--per-trade')) : undefined,
          dailyUsd: flag(rest, '--daily') ? Number(flag(rest, '--daily')) : undefined,
          maxOpen: flag(rest, '--max-open') ? Number(flag(rest, '--max-open')) : undefined,
          cooldownMs: sec ? Number(sec) * 1000 : undefined,
          k: flag(rest, '--k') ? Number(flag(rest, '--k')) : undefined,
          autoDisarmStreak: flag(rest, '--disarm') ? Number(flag(rest, '--disarm')) : undefined,
        });
        if (has(rest, '--json')) { out(JSON.stringify(p)); return 0; }
        out(`auto-mirror caps for ${shortAddr(addr)}: ≤ $${autoSizeCap(p).toFixed(2)} per mirror (¼ of the $${Math.min(p.perTradeUsd, p.dailyUsd)} per-trade cap, hands-free tier) · $${p.dailyUsd}/day · max ${p.maxOpen} open · ${Math.round(p.cooldownMs / 1000)} s cooldown · k=${p.k} · auto-disarm after ${p.autoDisarmStreak} refused/failed · ceilings $${AUTO_HARD.perTradeUsd}/trade $${AUTO_HARD.dailyUsd}/day`);
        out('status: OFF · enable in the app with a keypress: U → A (after the "less safe" popup, G on the O screen) · mirror-sell is not built');
        return 0;
      } catch (e) { errOut(`dexterm follow auto: ${e instanceof Error ? e.message : String(e)}`); return 1; }
    }
    case 'purge': {
      if (!has(rest, '--yes')) { errOut('dexterm follow purge: add --yes to delete every follow and label'); return 2; }
      out(`purged ${store.purge()} follow(s) and their labels`);
      return 0;
    }
    case 'stats':
    case 'trades': {
      const addr = rest[1];
      if (!isWalletAddress(addr)) { errOut(`usage: dexterm follow ${cmd} <addr>`); return 2; }
      let dl: DataLayer | null = null;
      let history: HistorySource | null;
      if (over.history !== undefined) history = over.history;
      else {
        const rpc = resolveRpcUrl({ env: io.env });
        if (rpc.provider !== 'helius') history = null;
        else { dl = createDataLayer({ rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl }); history = dl.rpcPool.heliusUrl ? new HeliusHistory(dl.http, dl.rpcPool.heliusUrl) : null; }
      }
      try {
        const scratch = new FollowStore();
        scratch.add(addr);
        const tracker = new WalletTracker({ follows: scratch, history, solUsd: () => over.solUsd ?? null });
        const st = tracker.status();
        if (st.state === 'unavailable') { errOut(`dexterm follow ${cmd}: ${st.why}`); return 1; }
        await tracker.pollOnce();
        const after = tracker.status();
        if (after.state === 'degraded') { errOut(`dexterm follow ${cmd}: ${after.why}`); return 1; }
        if (cmd === 'stats') {
          const s = tracker.stats(addr);
          if (has(rest, '--json')) { out(JSON.stringify({ ...s, positions: s.positions.map((p) => ({ ...p, tokensRaw: p.tokensRaw.toString(), peakRaw: p.peakRaw.toString() })) })); return 0; }
          for (const line of fmtStats(s)) out(line);
          return 0;
        }
        const limit = Number(flag(rest, '--limit') ?? 20);
        const trades = tracker.trades(addr).slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20);
        if (!trades.length) { out('no swaps in the fetched history'); return 0; }
        for (const tr of trades) out(`${tr.tKnown ? new Date(tr.t).toISOString().replace('T', ' ').slice(0, 19) : 'time unknown      '}  ${tr.side.toUpperCase().padEnd(8)} ${shortAddr(tr.mint)}  ${tr.solDelta !== null ? `${Math.abs(tr.solDelta).toFixed(4)} SOL` : 'unpriced   '}${tr.usd !== null ? ` ≈ $${tr.usd.toFixed(2)}` : ''}${tr.note ? `  (${tr.note})` : ''}  ${tr.sig.slice(0, 12)}…`);
        return 0;
      } finally { dl?.close(); }
    }
    default:
      if (cmd) { errOut(`dexterm follow: unknown subcommand ${JSON.stringify(cmd)}`); errOut(USAGE); return 2; }
      out(USAGE);
      return 0;
  }
}
