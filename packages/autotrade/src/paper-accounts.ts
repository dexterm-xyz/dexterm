// dexterm autotrade — paper ACCOUNTS: several strategies trading from one simulated wallet (task-1538). PAPER only.
//
// Without an account every strategy of a parallel run owns its bankroll (its own SimBook, its own cash). A paper
// account is one shared pool of simulated cash that any number of strategies trade from, the way several bots would
// share one real wallet:
//
//   account "main" ($1000) ── strategy moon  (own positions, loss streak, per-coin rules, entries/day)
//                          └─ strategy scalp (own positions, …)
//   account "yolo" (1 SOL) ── strategy scalp again (the same rules, another account: its own member, ledger and book)
//
// What is shared: the cash (a fill spends from, and a sale pays into, the account), the equity every strategy sizes
// from (cash + every open cost basis on the account, so "5% of the bankroll" means 5% of the wallet), and the
// drawdown / day-start figures each strategy's breaker reads (the wallet's drawdown halts each strategy at its own
// threshold). What stays per strategy: positions, exposure (its own footprint against the wallet), loss streak,
// cooldowns, per-coin limits, entry counts, its session caps and its P/L.
//
// Nothing here holds a key or touches a wallet: an account is a number in memory for the length of one run.

import type { SimBook } from './engine.ts';

/** How many paper accounts one parallel run holds at most. */
export const MAX_PAPER_ACCOUNTS = 8;

export interface PaperAccountView {
  id: string;
  startUsd: number;
  /** Simulated cash on the account now. */
  cashUsd: number;
  /** Cash + what every open bag of every strategy on it would sell for now (stuck bags count 0). */
  equityUsd: number;
  pnlUsd: number;
  pnlPct: number | null;
  /** Cost basis still open, all strategies together. */
  openCostUsd: number;
  positions: number;
  /** Strategies (member ids) that have traded or are trading from it in this run. */
  strategies: string[];
  sol?: number;
  solUsd?: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class PaperAccount {
  readonly id: string;
  readonly startUsd: number;
  readonly sol?: number;
  readonly solUsd?: number;
  cashUsd: number;
  private readonly books: { member: string; book: SimBook }[] = [];

  constructor(id: string, startUsd: number, o: { sol?: number; solUsd?: number } = {}) {
    if (!(startUsd > 0) || !Number.isFinite(startUsd)) throw new Error(`paper account ${id}: the starting balance must be a positive number`);
    this.id = id; this.startUsd = startUsd; this.cashUsd = startUsd;
    if (o.sol !== undefined) { this.sol = o.sol; this.solUsd = o.solUsd; }
  }

  /** Cash held for fills in flight (an executor is async: the debit lands after it answers). */
  private held = 0;
  /** Hold `usd` of the cash for one fill; false when the cash (less what other fills hold) is not there. */
  hold(usd: number): boolean {
    if (!(usd >= 0) || usd > this.cashUsd - this.held + 1e-9) return false;
    this.held += usd;
    return true;
  }
  /** Release a hold (the fill was booked, synchronously after the executor answered, or refused). */
  release(usd: number): void { this.held = Math.max(0, this.held - usd); }

  /** A strategy's book joins the account (SimBook's constructor calls this). A book never leaves: a stopped strategy's bags stay on the account. */
  join(book: SimBook, member = book.strategy.id): void { this.books.push({ member, book }); }

  /** Cash + every open cost basis (unrealized gains do not count for sizing). */
  bookEquity(): number { let e = this.cashUsd; for (const b of this.books) e += b.book.openCostUsd(); return e; }
  /** Cash + every open bag marked at what it would sell for now. */
  markedEquity(): number { let e = this.cashUsd; for (const b of this.books) e += b.book.openMarkUsd(); return e; }

  view(): PaperAccountView {
    const eq = this.markedEquity();
    const pnl = r2(eq - this.startUsd);
    let open = 0, positions = 0;
    for (const b of this.books) { open += b.book.openCostUsd(); positions += b.book.open.size; }
    return {
      id: this.id, startUsd: r2(this.startUsd), cashUsd: r2(this.cashUsd), equityUsd: r2(eq), pnlUsd: pnl, pnlPct: Math.round((pnl / this.startUsd) * 1000) / 10,
      openCostUsd: r2(open), positions, strategies: [...new Set(this.books.map((b) => b.member))],
      ...(this.sol !== undefined ? { sol: this.sol, solUsd: this.solUsd } : {}),
    };
  }
}
