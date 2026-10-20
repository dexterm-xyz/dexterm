// task-1443 capture round 3: over MCP, a PAPER close whose quote hits a 429 is re-quoted by the desk; the retry
// is visible on the spectator channel WHILE the call is in flight (a refused-phase line naming the wait), the
// quotes go through the quote-only layer the live server passes, and the fill result says it was re-quoted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpTools } from '../src/index.ts';
import { paperWiring } from '../src/server.ts';
import { recordForToolCall, type McpSpectatorRecord, type LiveSpectatorSink } from '../src/spectator-sink.ts';
import {
  SOL_MINT, JupiterRateLimitedError, writePaperAgentRendezvous, clearPaperAgentRendezvous, systemClock,
  type DataLayer, type QuoteRequest, type SwapQuote,
} from '@dexterm/data';
import { Journal, PlanService } from '@dexterm/data/plans';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function quote(req: QuoteRequest): SwapQuote {
  const buy = req.inputMint === SOL_MINT;
  const out = buy ? BigInt(Math.max(1, Math.floor(Number(req.amount) / 1000))) : BigInt(Number(req.amount) * 1000);
  return {
    inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount: out,
    otherAmountThreshold: out, mode: 'ExactIn', slippageBps: req.slippageBps, priceImpactPct: 0.4, route: ['Pump.fun Amm'],
    platformFeeBps: null, platformFeeAmount: null, usdValue: null, contextSlot: null, source: 'jupiter-swap', fetchedAt: Date.now(),
  };
}

test('a 429 on a PAPER close is re-quoted on the quote layer and shown on the spectator channel', async () => {
  const home = mkdtempSync(join(tmpdir(), 'paper-retry-'));
  const env = { DEXTERM_HOME: home } as NodeJS.ProcessEnv;
  const readData = {
    jupiterSwap: { quote: () => Promise.reject(new Error('reads layer must not price paper trades when a quote layer is given')) },
    jupiter: { price: async (mints: string[]) => new Map(mints.map((m) => [m, { usdPrice: 150 }])) },
  } as unknown as DataLayer;
  const sells: number[] = [];
  let failNextSell = 1;
  const quoteData = {
    jupiterSwap: {
      quote: (req: QuoteRequest) => {
        if (req.inputMint !== SOL_MINT) {
          sells.push(Date.now());
          if (failNextSell-- > 0) return Promise.reject(new JupiterRateLimitedError(429, 'https://api.jup.ag', 1_000, 3));
        }
        return Promise.resolve(quote(req));
      },
    },
  } as unknown as DataLayer;
  const svc = new PlanService({ journalPath: join(home, 'plans.journal'), clock: systemClock });
  const m = svc.draftMandate({ perTradeUsd: 20, totalUsd: 100 });
  svc.armMandateByKeypress(m.id, 'keypress');
  writePaperAgentRendezvous({ db: join(home, 'wallet.db'), mandateId: m.id, agent: 'test' }, env);

  const records: McpSpectatorRecord[] = [];
  const spectator: LiveSpectatorSink = { active: () => true, record: (o) => { records.push(recordForToolCall({ seq: records.length + 1, agent: 'test', ...o })); } };
  const tools = new McpTools(readData, () => ({}), null, null, paperWiring(env, readData, spectator, () => quoteData));
  const open = await tools.call('paper_open_ticket', { mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
  const ticketId = (open.ticket as { id: string }).id;
  await tools.call('paper_size_ticket', { ticketId, usd: 4 });
  assert.equal(((await tools.call('paper_confirm', { ticketId })).fill as { paper: boolean }).paper, true);
  assert.equal(records.length, 0, 'a clean buy writes no retry line (the server records the completed call itself)');

  const closed = await tools.call('paper_close', { mint: MINT, fraction: 0.34 });
  assert.equal(typeof closed.error, 'undefined', String(closed.error));
  assert.equal((closed.fill as { side: string }).side, 'sell');
  assert.equal(closed.quoteAttempts, 2);
  assert.match(String(closed.quoteNote), /attempt 2 after a rate limit/);
  assert.equal(sells.length, 2);
  assert.ok(sells[1] - sells[0] >= 950, 'the desk waited the stated 1 s before re-quoting');

  assert.equal(records.length, 1, 'one in-flight retry line');
  const r = records[0];
  assert.equal(r.tool, 'paper_close');
  assert.equal(r.phase, 'refused');
  assert.equal(r.nav, null, 'a retry line never moves the screen');
  assert.match(r.summary, /^error: PAPER sell quote rate-limited · re-quoting in 1s \(try 2\/4\)/);

  const aj = new Journal({ path: join(home, 'paper-agent.journal'), clock: systemClock });
  assert.ok(aj.verify().ok);
  assert.ok(aj.types().includes('agent.paper.quote-retry'));
  clearPaperAgentRendezvous(env);
  rmSync(home, { recursive: true, force: true });
});
