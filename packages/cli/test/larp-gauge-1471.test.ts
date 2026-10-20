// task-1471: the analyst panel's LARP score gauge reads the MCP larp_check tool_result off the stream, never
// the model's answer. Fake claude child; no network, no spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { THEMES, Canvas } from '@dexterm/tui';
import { AnalystSession } from '../src/index.ts';
import { parseLarpGauge, larpGaugeText, drawLarpGauge } from '../src/analyst/larp-gauge.ts';
import { renderAnalystSession } from '../src/screens/analyst-session.ts';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (sig?: string) => boolean };
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
  return child;
}
const line = (o: unknown) => JSON.stringify(o) + '\n';
const LARP_RESULT = {
  flags: ['no website advertised'], score: 37, band: 'medium',
  larp_score: {
    model: 'larp-score-v1', score: 37, band: 'medium', range: { lo: 37, hi: 58, bandLo: 'medium', bandHi: 'high' }, thresholds: { medium: 25, high: 50 },
    flags: [], top: [{ id: 'x_account_days_old', points: 12, label: 'X account under 7 days old' }, { id: 'no_telegram', points: 12, label: 'no Telegram advertised' }, { id: 'no_website', points: 9, label: 'no website advertised' }],
    missing: [{ id: 'x:*', group: 'x', what: 'x', maxPoints: 21 }], measured: 'm', caveat: 'c',
  },
};

test('parseLarpGauge accepts the MCP shape and rejects malformed numbers', () => {
  const g = parseLarpGauge(LARP_RESULT)!;
  assert.equal(g.score, 37); assert.equal(g.band, 'medium'); assert.equal(g.hi, 58); assert.equal(g.top.length, 3); assert.equal(g.missing, 1);
  assert.equal(larpGaugeText(g), 'LARP score 37/100 medium · could be up to 58 (1 unread)');
  assert.equal(parseLarpGauge({ larp_score: { ...LARP_RESULT.larp_score, score: 140 } }), null);
  assert.equal(parseLarpGauge({ larp_score: { ...LARP_RESULT.larp_score, band: 'SAFE' } }), null);
  assert.equal(parseLarpGauge({ score: 37 }), null, 'only the structured larp_score counts');
});

test('the session takes the gauge from the larp_check tool_result, not from the model answer', () => {
  const child = fakeChild();
  let changes = 0;
  const s = new AnalystSession({ skill: 'larp-check', mint: 'fixture', screenState: {} }, () => { changes++; }, { spawn: (() => child) as never });
  s.start();
  child.stdout.emit('data', Buffer.from(
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__dexterm__larp_check', input: { mint: 'fixture' } }] } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: JSON.stringify(LARP_RESULT) }] }] } }) +
    line({ type: 'result', structured_output: { skill: 'larp-check', verdict: 'UNVERIFIABLE', confidence: 0.4, summary: 'score 99 says the model', flags: [], larp_score: { score: 99 } } }),
  ));
  assert.ok(changes > 0);
  assert.equal(s.larpGauge?.score, 37, 'the tool number, not the model\'s 99');
  assert.equal(s.productAssessment?.verdict, 'UNVERIFIABLE');
  const cv = new Canvas(64, 30, THEMES.cyberspace);
  renderAnalystSession(cv, 0, 0, 64, 30, s, { frame: 0, code: '', calm: true, revealAll: true } as never);
  const plain = cv.toPlain();
  assert.match(plain, /LARP\s+37\/100 [█▒┊·]+ medium ≤58/);
  assert.match(plain, /\+12 X account under 7 days old/);
  assert.match(plain, /1 check unread: range 37–58, not counted as clean/);
});

test('a tool_result for another tool, or junk JSON, sets no gauge', () => {
  const child = fakeChild();
  const s = new AnalystSession({ skill: 'larp-check', mint: 'fixture', screenState: {} }, () => {}, { spawn: (() => child) as never });
  s.start();
  child.stdout.emit('data', Buffer.from(
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__dexterm__get_links', input: {} }, { type: 'tool_use', id: 'b', name: 'mcp__dexterm__larp_check', input: {} }] } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: JSON.stringify(LARP_RESULT) }, { type: 'tool_result', tool_use_id: 'b', content: 'not json' }] } }),
  ));
  assert.equal(s.larpGauge, null);
});

test('drawLarpGauge stays inside its width and row budget', () => {
  const cv = new Canvas(30, 3, THEMES.cyberspace);
  const y = drawLarpGauge(cv, 0, 0, 30, 2, parseLarpGauge(LARP_RESULT)!, THEMES.cyberspace.bg);
  assert.equal(y, 2, 'bar + one reason row, then out of rows');
  for (const row of cv.toPlain().split('\n')) assert.ok([...row].length <= 30);
});
