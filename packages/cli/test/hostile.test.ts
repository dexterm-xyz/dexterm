// Hostile input (task-1279 verification fix): names that live on Object.prototype must be ordinary
// unknown tags / values / fields / sort keys / presets, never inherited lookups, and no filter string
// may throw anywhere between the parser and the interactive key loop. The fuzz below keeps that
// property: ≥ 200 hostile strings through parse → state → editor keystrokes, 0 exceptions, each
// under 50 ms, and no prototype pollution afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys, type Key, type ScreenKey } from '@dexterm/tui';
import { makeFixtures } from '../src/fixtures.ts';
import { fromFixture, type ScreenerRow } from '../src/screener/rows.ts';
import { parseFilter, parseValue, applyFilter, fieldSpec, clausePredicate, type Clause } from '../src/screener/filter.ts';
import { parseSortArg, sortSpec, sortRows } from '../src/screener/sort.ts';
import { presetSpec } from '../src/screener/presets.ts';
import { makeScreenerState, setFilter, setSort, openFilterEditor, filterEditorKey, screenerView } from '../src/screener/view.ts';
import { makeFixtureState, renderFrame } from '../src/state.ts';
import { applyKey, parseArgs, stateFromArgs } from '../src/main.ts';

const rows: ScreenerRow[] = makeFixtures(7).tokens.map(fromFixture);
const keys = (s: string): Key[] => parseKeys(s);

/** Names every plain object inherits; each one used to leak through `table[key]`. */
export const PROTO_NAMES = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', '__lookupGetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];

test('prototype-named tags are unknown tags, with the normal grammar error and column', () => {
  for (const name of PROTO_NAMES) {
    for (const src of [`${name}:yes`, `${name}:true`, `!${name}:no`, `  ${name}:1`]) {
      const r = parseFilter(src);
      assert.ok(!r.ok, `${src} must not parse`);
      assert.match(r.error, new RegExp(`unknown tag "${name}:"`), src);
      assert.equal(r.at, src.indexOf(name) + 1, `${src}: column`);
    }
  }
});

test('prototype-named launchpads, flags and yes/no words are rejected, not silently empty', () => {
  for (const name of PROTO_NAMES) {
    const lp = parseFilter(`launchpad:${name}`);
    assert.ok(!lp.ok && /unknown launchpad/.test(lp.error), `launchpad:${name} → ${lp.ok ? 'parsed' : lp.error}`);
    const lp2 = parseFilter(`lp:${name}`);
    assert.ok(!lp2.ok && /unknown launchpad/.test(lp2.error), `lp:${name}`);
    const fl = parseFilter(`flag:${name}`);
    assert.ok(!fl.ok && /unknown flag/.test(fl.error), `flag:${name} → ${fl.ok ? 'parsed' : fl.error}`);
    const v = parseFilter(`verified:${name}`);
    assert.ok(!v.ok && /takes yes or no/.test(v.error), `verified:${name}`);
    const s = parseFilter(`!sus:${name}`);
    assert.ok(!s.ok && /takes yes or no/.test(s.error), `!sus:${name}`);
    const ch = parseFilter(`chain:${name}`);
    assert.ok(!ch.ok && /solana only/.test(ch.error), `chain:${name}`);
  }
});

test('prototype-named fields and units are unknown; values never become NaN through an inherited unit', () => {
  for (const name of PROTO_NAMES) {
    assert.equal(fieldSpec(name), undefined, name);
    const f = parseFilter(`${name} > 1`);
    assert.ok(!f.ok && /unknown field/.test(f.error), `${name} > 1`);
    const unit = name.toLowerCase();
    if (/^[a-z]+$/.test(unit)) {
      for (const kind of ['usd', 'num', 'price'] as const) {
        const v = parseValue(`1${unit}`, kind);
        assert.equal(typeof v, 'string', `1${unit} as ${kind} must be an error, got ${String(v)}`);
        assert.match(v as string, /unknown unit/);
      }
      const a = parseValue(`1${unit}`, 'age');
      assert.equal(typeof a, 'string', `1${unit} as age`);
      assert.match(a as string, /unknown age unit/);
    }
  }
  // real units still work after the own-property change
  assert.equal(parseValue('2K', 'usd'), 2000);
  assert.equal(parseValue('3d', 'age'), 3 * 1440);
});

test('a hand-built clause with a tag the parser never emits matches nothing instead of throwing', () => {
  const c = { kind: 'tag', tag: '__proto__', value: 'yes', not: false, raw: '__proto__:yes' } as unknown as Clause;
  assert.equal(applyFilter(rows, { text: '', clauses: [c], predicate: clausePredicate(c) }).length, 0);
  const n = { ...c, not: true } as unknown as Clause;
  assert.equal(applyFilter(rows, { text: '', clauses: [n], predicate: clausePredicate(n) }).length, rows.length);
});

test('prototype-named sort keys and presets are unknown on the CLI and inert on the state', () => {
  for (const name of PROTO_NAMES) {
    assert.equal(sortSpec(name), undefined, name);
    assert.throws(() => parseSortArg(name), /unknown sort key/, name);
    assert.throws(() => parseSortArg(`${name}:asc`), /unknown sort key/, name);
    assert.throws(() => parseArgs(['--sort', name]), /unknown sort key/, name);
    assert.equal(presetSpec(name), undefined, name);
    assert.throws(() => parseArgs(['--preset', name]), /unknown preset/, name);
    assert.throws(() => parseArgs(['--filter', `${name}:yes`]), /unknown tag/, name);
    assert.throws(() => stateFromArgs(parseArgs(['--fixtures', '--theme', name])), /unknown theme/, name);
    assert.deepEqual(sortRows(rows, name, 'desc').map((r) => r.mint), rows.map((r) => r.mint), 'unknown sort key keeps the order');
    const sc = makeScreenerState('fixtures', rows);
    setSort(sc, name, 'asc');
    assert.deepEqual(sc.sort, { key: 'vol', dir: 'desc' }, `setSort(${name}) is a no-op`);
  }
});

test('TUI path: / then __proto__:yes then enter keeps the editor open with the grammar error, never throws', () => {
  for (const src of ['__proto__:yes', 'constructor:true', '!__proto__:no', 'launchpad:constructor', 'flag:constructor', 'liq > 1constructor']) {
    const state = makeFixtureState({ screen: 'screener', selected: 5 });
    const stack: ScreenKey[] = [];
    applyKey(state, keys('/')[0], stack);
    for (const k of keys(`${src}\r`)) applyKey(state, k, stack);
    assert.equal(state.screener.mode, 'filter', `${src}: editor stays open`);
    assert.ok(state.screener.edit.error, `${src}: error shown`);
    assert.equal(state.screener.filter, null, `${src}: nothing applied`);
    assert.equal(screenerView(state.screener).length, rows.length);
    const plain = renderFrame(state, 120, 30).toPlain();
    assert.match(plain, /✗ unknown/, `${src}: frame shows the error`);
    // esc leaves the editor, q still quits
    applyKey(state, keys('\x1b')[0], stack);
    assert.equal(state.screener.mode, 'table');
    assert.equal(applyKey(state, keys('q')[0], stack), 'quit');
  }
});

// ---------------------------------------------------------------------------------------------
// fuzz

function hostileInputs(): string[] {
  const out: string[] = [];
  const tags = ['chain', 'launchpad', 'lp', 'flag', 'verified', 'sus', 'color', ...PROTO_NAMES];
  const vals = ['yes', 'no', 'pump', 'mint', 'clean', 'solana', '', ' ', ...PROTO_NAMES];
  for (const t of tags) for (const v of vals.slice(0, 8)) { out.push(`${t}:${v}`); out.push(`!${t}:${v}`); }
  for (const t of PROTO_NAMES) for (const v of PROTO_NAMES) out.push(`${t}:${v}`);
  const fields = ['vol24', 'liq', 'age', 'top10', 'price', 'holders', ...PROTO_NAMES];
  const nums = ['1', '-1', '0', '1e308', '1e309', '9'.repeat(400), '0.' + '0'.repeat(300) + '1', '1constructor', '1__proto__', '5toString', '1k', '1mo', 'NaN', 'Infinity', '-Infinity', '0x10', '1_000', '١٢٣', '１２３', '1,,,2', '$$$1', '%%', '1%%'];
  for (const f of fields) for (const n of nums) out.push(`${f} > ${n}`);
  for (const op of ['>', '>=', '<', '<=', '=', '==', '!=', '=>', '=<', '<>', '!', ':', '!!', '::', '!:', ':!']) out.push(`liq ${op} 1`, `${op}`, `${op}${op}${op}`);
  // unicode, bidi, zero-width, control, emoji, fullwidth, combining
  out.push('‮__proto__:yes', '​__proto__​:yes', 'vol24 > 1M', '﻿liq > 1', 'ＶＯＬ２４ ＞ １Ｍ', 'é́́́:yes', '🐱🐱🐱', '🐱 > 1', 'liq > 🐱', '\x00\x01\x02', '\x1b[2J\x1b[H', '\r\n\t', 'liq\n>\n1', 'ñandú', 'ß > 1', 'İ:yes', 'ǅ > 1', '\ud800', '\udfff', 'a\ud800b', '𝕍𝕆𝕃 > 1', '\u0000__proto__:yes');
  // huge and repeated
  out.push('x'.repeat(10_000), 'liq > 1 '.repeat(1_300), '__proto__:yes '.repeat(700), '!'.repeat(10_000), ':'.repeat(10_000), '>'.repeat(10_000), ' '.repeat(10_000), 'liq>'.repeat(2_500), ('9'.repeat(50) + ' ').repeat(200), '🐱'.repeat(5_000), 'vol24 > 1M liq > 50K age < 30d launchpad:pump !flag:mint cat '.repeat(160));
  // injection-shaped
  out.push('{"__proto__":{"x":1}}', "'; DROP TABLE rows; --", '${process.exit(1)}', '`id`', '$(id)', '%s%s%s%n', 'constructor.prototype.polluted', '__proto__.polluted', 'constructor:prototype', '__proto__[polluted]:yes', 'toString:valueOf', 'liq > 1 __proto__:yes constructor:true', 'launchpad:__proto__ flag:constructor');
  return [...new Set(out)];
}

/**
 * One hostile string through every path a user can reach: parser, state, editor keystrokes, the
 * key loop, a frame. Returns the milliseconds spent on the filter's own work (parse, apply, state,
 * keystrokes, key loop); building the fixture state and rendering the frame run for exception
 * coverage but are not the input's cost.
 */
function exercise(src: string, counts: { parsedOk: number; rejected: number }): number {
  let ms = 0;
  const timed = (fn: () => void) => { const t0 = performance.now(); fn(); ms += performance.now() - t0; };
  timed(() => {
    const r = parseFilter(src);
    if (r.ok) { counts.parsedOk++; applyFilter(rows, r.filter); }
    else {
      counts.rejected++;
      assert.equal(typeof r.error, 'string');
      assert.ok(r.error.length > 0, 'rejection has a message');
      assert.ok(Number.isInteger(r.at) && r.at >= 1, `rejection has a 1-based column (${r.at})`);
    }
    const sc = makeScreenerState('fixtures', rows);
    setFilter(sc, src);
    screenerView(sc);
    openFilterEditor(sc);
    for (const k of keys(src.slice(0, 220) + '\r')) filterEditorKey(sc, k);
  });
  // the interactive route: '/' + text + enter + esc through applyKey, then a frame
  const state = makeFixtureState({ screen: 'screener' });
  const stack: ScreenKey[] = [];
  timed(() => {
    applyKey(state, keys('/')[0], stack);
    for (const k of keys(src.slice(0, 220) + '\r\x1b')) applyKey(state, k, stack);
  });
  renderFrame(state, 90, 24).toPlain();
  return ms;
}

test('fuzz: ≥ 200 hostile filter strings never throw through parse, state, editor keystrokes and the key loop, each < 50 ms', () => {
  const inputs = hostileInputs();
  assert.ok(inputs.length >= 200, `only ${inputs.length} inputs`);
  const polluted = Object.create(null);
  let exceptions = 0;
  let slow = 0;
  let maxMs = 0;
  let retimed = 0;
  let slowest = '';
  const counts = { parsedOk: 0, rejected: 0 };
  const findings: string[] = [];
  // warm the JIT on benign input so the first hostile strings are not charged for compiling the renderer
  for (const w of ['vol24 > 1M', 'launchpad:pump cat', '']) exercise(w, { parsedOk: 0, rejected: 0 });
  for (const src of inputs) {
    let ms = Infinity;
    // the budget is about the parser's cost, not the scheduler's: an input over 50 ms is re-timed
    // (the full suite runs test files in parallel) and the best of five counts
    for (let attempt = 0; attempt < 5 && ms >= 50; attempt++) {
      if (attempt > 0) retimed++;
      try {
        ms = Math.min(ms, exercise(src, attempt === 0 ? counts : { parsedOk: 0, rejected: 0 }));
      } catch (e) {
        exceptions++;
        findings.push(`${JSON.stringify(src.slice(0, 60))}: ${(e as Error).message}`);
        break;
      }
    }
    if (ms > maxMs) { maxMs = ms; slowest = src; }
    if (ms >= 50) { slow++; findings.push(`${JSON.stringify(src.slice(0, 60))}: ${ms.toFixed(1)} ms`); }
  }
  const { parsedOk, rejected } = counts;
  assert.equal(exceptions, 0, `exceptions:\n${findings.join('\n')}`);
  assert.equal(slow, 0, `slow inputs (max ${maxMs.toFixed(1)} ms):\n${findings.join('\n')}`);
  assert.ok(parsedOk > 0 && rejected > 0, `parsedOk=${parsedOk} rejected=${rejected}`);
  // no prototype pollution
  assert.equal((polluted as { polluted?: unknown }).polluted, undefined);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  assert.equal(({} as { x?: unknown }).x, undefined);
  assert.equal(typeof ({}).toString, 'function');
  process.stdout.write(`  fuzz: ${inputs.length} inputs, ${exceptions} exceptions, ${slow} over 50 ms, max ${maxMs.toFixed(2)} ms for ${JSON.stringify(slowest.length > 40 ? slowest.slice(0, 37) + '…' : slowest)} (${retimed} re-timed), ${parsedOk} parsed, ${rejected} rejected\n`);
});
