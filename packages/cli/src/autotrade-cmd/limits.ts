// `dexterm autotrade limits …` (task-1654, 0.2.0 card E): every real-mode limit, user-set, per scope.
//
//   show      the effective limits (for a strategy / account / mode) and where each number comes from
//   set       name=value … in a scope (global | real | paper | strategy:<id> | account:<id>); lowering is immediate,
//             raising shows the old -> new diff and needs the typed phrase on a real terminal
//   diff      a proposed file (--file) against the limits now, or limits.json against dexterm's last journaled save
//   reset     a scope (or one --key) back to the placeholder defaults (a raise if that loosens anything: typed)
//   accept    take a hand-edited limits.json (typed when it raises anything; a lower-only edit is accepted as is)
//   breaker   `breaker reset`: lift a tripped drawdown breaker (typed)
//   explain   what each limit does    schema  the JSON Schema of the file
//
// No MCP tool, model decision or chat command reaches the writing paths: the analyst can read and explain the limits
// and propose a diff card (MCP limits_propose), which only YOU can apply here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dextermHome } from '@dexterm/custom';
import {
  DEFAULT_LIMITS, LIMIT_FIELDS, LIMIT_KEYS, changeLine, diffLimits, effectiveLimits, emptyLimits, limitField, limitsLines, limitsPath, limitsSummary, loadArmings, loadLimits, loadRiskState,
  parseLimitAssignment, planLimitsSave, raises, resetBreaker, saveLimits, scopeRef, validateLimits, type LimitChange, type LimitKey, type LimitsDoc, type LimitsPlan, type LimitSet,
} from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';
import { confirmTyped, isTty, typedLine, type SignalDeps } from './signal.ts';

export const LIMITS_USAGE = [
  'dexterm autotrade limits show [--strategy ID] [--account ID] [--mode real|paper] [--all] [--json]',
  'dexterm autotrade limits set [--scope global|real|paper|strategy:ID|account:ID] name=value … (value "off" turns a global limit off)',
  'dexterm autotrade limits diff [--file FILE] [--json]',
  'dexterm autotrade limits reset [--scope S] [--key NAME]',
  'dexterm autotrade limits accept | breaker reset | explain [NAME] | schema',
].join('\n');

const out = (io: AutotradeIo, s: string) => { io.stdout.write(`${s}\n`); };
const err = (io: AutotradeIo, s: string) => { io.stderr.write(`dexterm autotrade limits: ${s}\n`); };

export const LIMITS_SCHEMA_FILE = fileURLToPath(new URL('../../../autotrade/assets/limits.schema.json', import.meta.url));

export async function limitsCmd(argv: string[], io: AutotradeIo, deps: SignalDeps = {}): Promise<number> {
  const home = dextermHome(io.env);
  const now = deps.now ?? Date.now;
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case undefined: case 'help': out(io, LIMITS_USAGE); return 0;
    case 'show': return showCmd(rest, io, home, now);
    case 'set': return setCmd(rest, io, home, deps, now);
    case 'diff': return diffCmd(rest, io, home);
    case 'reset': return resetCmd(rest, io, home, deps, now);
    case 'accept': return acceptCmd(io, home, deps, now);
    case 'breaker': {
      if (rest[0] !== 'reset') { err(io, 'usage: dexterm autotrade limits breaker reset'); return 2; }
      const r = loadRiskState(home, now());
      if (!r.breaker) { out(io, 'the drawdown breaker is not tripped'); return 0; }
      out(io, `the drawdown breaker tripped ${new Date(r.breaker.at).toISOString()} at ${r.breaker.drawdownSol} SOL below the peak; resetting it lets new real buys go out again (it also lifts a loss-streak pause and restarts the streak count)`);
      const code = await confirmTyped(io, deps, 'RESET', 'breaker');
      if (!code) return 1;
      const x = resetBreaker(home, { confirmed: true, now: now() });
      if (!x.ok) { err(io, x.why); return 1; }
      out(io, 'drawdown breaker reset (journaled); the peak starts again from here; any loss-streak pause is lifted too');
      return 0;
    }
    case 'explain': return explainCmd(rest, io);
    case 'schema': out(io, readFileSync(LIMITS_SCHEMA_FILE, 'utf8').trimEnd()); return 0;
    default: err(io, `unknown subcommand ${JSON.stringify(sub)}\n${LIMITS_USAGE}`); return 2;
  }
}

function current(home: string): { doc: LimitsDoc; note: string | null; ok: boolean } {
  const l = loadLimits(home);
  if (l.ok) return { doc: l.doc, ok: true, note: l.source === 'migrated' ? 'read from card A\'s caps.json (saved as limits.json on your next change)' : l.unjournaled ? `limits.json differs from dexterm's last save (${l.unjournaled.length} change(s)): dexterm autotrade limits diff` : null };
  if (l.missing) return { doc: emptyLimits(), ok: true, note: 'no limits saved yet: these are the placeholder defaults, NOT your numbers (real mode will not arm on them silently)' };
  return { doc: emptyLimits(), ok: false, note: l.why };
}

function showCmd(argv: string[], io: AutotradeIo, home: string, now: () => number): number {
  const { opts } = parseArgs(argv, ['json', 'all']);
  const mode = opts.mode === 'paper' ? 'paper' : 'real';
  const strategyId = typeof opts.strategy === 'string' ? opts.strategy : '-';
  const accountId = typeof opts.account === 'string' ? opts.account : '-';
  const c = current(home);
  if (!c.ok) { err(io, c.note ?? 'limits unreadable'); return 1; }
  const e = effectiveLimits(c.doc, { strategyId, accountId, mode });
  const armed = Object.values(loadArmings(home)).map((a) => ({ id: a.strategyId, accountId: a.accountId, limits: effectiveLimits(c.doc, { strategyId: a.strategyId, accountId: a.accountId, mode: 'real' }).values }));
  const risk = loadRiskState(home, now());
  if (opts.json) {
    out(io, JSON.stringify({ file: limitsPath(home), note: c.note, context: { mode, strategyId, accountId }, applies: e.applies, effective: e.values, from: e.from, scopes: c.doc, armed, risk: { day: risk.day, buys: risk.buys, buySol: risk.buySol, dayPnlSol: risk.dayPnlSol, cumPnlSol: risk.cumPnlSol, lossStreak: risk.lossStreak, pausedUntil: risk.pausedUntil, breaker: risk.breaker } }, null, 2));
    return 0;
  }
  out(io, `real-mode limits (${limitsPath(home)}) · outside the model: only you change them, here · the defaults are placeholders, your numbers win`);
  if (c.note) out(io, `  note: ${c.note}`);
  out(io, `effective for ${mode}${strategyId !== '-' ? ` · strategy ${strategyId}` : ''}${accountId !== '-' ? ` · account ${accountId}` : ''}${e.applies ? '' : ' · paper ignores the limits (add a "paper" scope to make forward tests obey them)'}:`);
  for (const l of limitsLines(e, { all: opts.all === true })) out(io, `  ${l}`);
  const scoped = [...(c.doc.modes.real ? ['real'] : []), ...(c.doc.modes.paper ? ['paper'] : []), ...Object.keys(c.doc.strategies).map((id) => `strategy:${id}`), ...Object.keys(c.doc.accounts).map((id) => `account:${id}`)];
  if (scoped.length) out(io, `  tighter scopes set: ${scoped.join(', ')} (the stricter number always wins)`);
  for (const a of armed) out(io, `  armed ${a.id} (account ${a.accountId}): ${limitsSummary(a.limits)}`);
  out(io, `  today: ${risk.buys} buys · ${risk.buySol} SOL · realized ${risk.dayPnlSol} SOL${risk.breaker ? ' · DRAWDOWN BREAKER TRIPPED (dexterm autotrade limits breaker reset)' : ''}${risk.pausedUntil && risk.pausedUntil > now() ? ` · loss-streak pause until ${new Date(risk.pausedUntil).toISOString().slice(11, 16)} UTC` : ''}`);
  return 0;
}

/**
 * Print the planned diff (planLimitsSave: measured from dexterm's last journaled save, so a hand edit's raises are
 * shown too) and, when anything is raised, take the typed phrase. Returns the raises confirmed (the exact list
 * saveLimits checks; empty when nothing raises), or null when not confirmed.
 */
export async function confirmPlan(io: AutotradeIo, deps: SignalDeps, plan: LimitsPlan, unjournaled: LimitChange[] | null = null, what: 'limits' | 'caps' = 'limits'): Promise<string[] | null> {
  for (const c of plan.changes) out(io, `  ${changeLine(c)}`);
  if (!plan.raised.length) return [];
  if (unjournaled && raises(unjournaled).length) out(io, `limits.json was changed outside dexterm and that edit RAISES ${raises(unjournaled).map((c) => `${c.scope}.${c.key}`).join(', ')}: it is part of this save (dexterm autotrade limits diff shows it alone)`);
  out(io, `${plan.raised.length} limit(s) RAISED (laxer). Raising applies from the next real run; a running one keeps the stricter number.`);
  return (await confirmTyped(io, deps, 'RAISE', what)) ? plan.raised : null;
}

async function setCmd(argv: string[], io: AutotradeIo, home: string, deps: SignalDeps, now: () => number): Promise<number> {
  const { pos, opts } = parseArgs(argv, ['json']);
  if (!pos.length) { err(io, 'set name=value … (dexterm autotrade limits explain lists the names)'); return 2; }
  const c = current(home);
  if (!c.ok) { err(io, `${c.note}; fix or remove the file first`); return 1; }
  const next: LimitsDoc = structuredClone(c.doc);
  delete next.migratedFrom;
  const scope = typeof opts.scope === 'string' ? opts.scope : 'global';
  const ref = scopeRef(next, scope, true);
  if ('error' in ref) { err(io, ref.error); return 2; }
  for (const a of pos) {
    const p = parseLimitAssignment(a);
    if ('error' in p) { err(io, p.error); return 2; }
    if (p.value === null && !ref.isGlobal) { delete ref.set![p.key]; continue; }
    ref.set![p.key] = p.value;
  }
  const issues = validateLimits(next);
  if (issues.length) { for (const i of issues) err(io, `${i.path}: ${i.msg}`); return 2; }
  const l = loadLimits(home);
  const plan = planLimitsSave(home, next);
  if (!plan.changes.length && l.ok) { out(io, 'unchanged'); return 0; }
  out(io, `limits ${scope}:`);
  const confirmed = await confirmPlan(io, deps, plan, l.ok ? l.unjournaled : null);
  if (!confirmed) return 1;
  const r = saveLimits(home, next, { confirmed, baseline: plan.baseline, now: now() });
  if (!r.ok) { err(io, r.why); return 1; }
  if (opts.json) { out(io, JSON.stringify({ saved: true, hash: r.hash, changes: r.changes }, null, 2)); return 0; }
  out(io, `saved (journaled, ${r.hash}) · lowered limits apply at once, even to a running real run`);
  return 0;
}

function diffCmd(argv: string[], io: AutotradeIo, home: string): number {
  const { opts } = parseArgs(argv, ['json']);
  const l = loadLimits(home);
  let before: LimitsDoc | null;
  let after: LimitsDoc;
  if (typeof opts.file === 'string') {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(opts.file, 'utf8')); } catch (e) { err(io, `cannot read ${opts.file}: ${(e as Error).message.slice(0, 80)}`); return 2; }
    const issues = validateLimits(raw);
    if (issues.length) { for (const i of issues) err(io, `${i.path}: ${i.msg}`); return 2; }
    before = l.ok ? l.doc : null; after = raw as LimitsDoc;
  } else {
    if (!l.ok) { err(io, l.why); return 1; }
    if (!l.unjournaled) { out(io, 'limits.json matches dexterm\'s last save'); return 0; }
    if (opts.json) { out(io, JSON.stringify({ unjournaled: l.unjournaled }, null, 2)); return 0; }
    out(io, 'limits.json vs dexterm\'s last journaled save:');
    for (const c of l.unjournaled) out(io, `  ${changeLine(c)}`);
    if (raises(l.unjournaled).length) out(io, 'it RAISES limits: a real run refuses it until you accept it (dexterm autotrade limits accept)');
    return 0;
  }
  const changes = diffLimits(before, after);
  if (opts.json) { out(io, JSON.stringify({ changes }, null, 2)); return 0; }
  if (!changes.length) { out(io, 'no change'); return 0; }
  for (const c of changes) out(io, `  ${changeLine(c)}`);
  return 0;
}

async function resetCmd(argv: string[], io: AutotradeIo, home: string, deps: SignalDeps, now: () => number): Promise<number> {
  const { opts } = parseArgs(argv);
  const c = current(home);
  if (!c.ok) { err(io, c.note ?? 'limits unreadable'); return 1; }
  const next: LimitsDoc = structuredClone(c.doc);
  delete next.migratedFrom;
  const scope = typeof opts.scope === 'string' ? opts.scope : 'global';
  const ref = scopeRef(next, scope, false);
  if ('error' in ref) { err(io, ref.error); return 2; }
  const key = typeof opts.key === 'string' ? parseLimitAssignment(`${opts.key}=0`) : null;
  if (key && 'error' in key) { err(io, key.error); return 2; }
  if (!ref.set) { out(io, `${scope} has nothing set`); return 0; }
  if (key) delete ref.set[key.key];
  else if (ref.isGlobal) next.global = {};
  else if (scope === 'real' || scope === 'paper') delete next.modes[scope];
  else { const [kind, id] = scope.split(':'); delete next[kind === 'strategy' ? 'strategies' : 'accounts'][id]; }
  const l = loadLimits(home);
  const plan = planLimitsSave(home, next);
  if (!plan.changes.length) { out(io, 'unchanged'); return 0; }
  out(io, `reset ${scope}${key ? `.${key.key}` : ''} (global numbers fall back to the placeholder defaults):`);
  const confirmed = await confirmPlan(io, deps, plan, l.ok ? l.unjournaled : null);
  if (!confirmed) return 1;
  const r = saveLimits(home, next, { confirmed, baseline: plan.baseline, action: 'limits-reset', now: now() });
  if (!r.ok) { err(io, r.why); return 1; }
  out(io, `saved (journaled, ${r.hash})`);
  return 0;
}

async function acceptCmd(io: AutotradeIo, home: string, deps: SignalDeps, now: () => number): Promise<number> {
  const l = loadLimits(home);
  if (!l.ok) { err(io, l.why); return 1; }
  if (!l.unjournaled) { out(io, 'limits.json already matches dexterm\'s last save'); return 0; }
  out(io, 'accept limits.json as it is now:');
  const plan = planLimitsSave(home, l.doc);
  const confirmed = await confirmPlan(io, deps, plan);
  if (!confirmed) return 1;
  // task-1654 r4 (verify F4): belt and braces. The plan and the integrity check share one baseline, so they agree;
  // should they ever not, an outside edit that raises anything still needs the typed phrase here.
  const outside = raises(l.unjournaled).map((c) => `${c.scope}.${c.key}`);
  if (outside.some((k) => !confirmed.includes(k))) { err(io, `the edit raises ${outside.join(', ')} but the planned save does not show it: nothing accepted (dexterm autotrade limits diff)`); return 1; }
  const r = saveLimits(home, l.doc, { confirmed, baseline: plan.baseline, action: 'limits-accept', now: now() });
  if (!r.ok) { err(io, r.why); return 1; }
  out(io, `accepted (journaled, ${r.hash})`);
  return 0;
}

function explainCmd(argv: string[], io: AutotradeIo): number {
  const want = argv[0] ? parseLimitAssignment(`${argv[0]}=0`) : null;
  if (want && 'error' in want) { err(io, want.error); return 2; }
  for (const f of LIMIT_FIELDS) {
    if (want && f.key !== want.key) continue;
    const d = DEFAULT_LIMITS[f.key as LimitKey];
    out(io, `${f.key} (${f.group}, ${f.unit}, ${f.dir === 'max' ? 'a cap: smaller is stricter' : 'a floor: larger is stricter'}; placeholder ${d === undefined ? 'off' : d})`);
    out(io, `  ${f.help}`);
  }
  if (!want) out(io, 'scopes: global (replaces the placeholder) · real / paper (a mode) · strategy:<id> · account:<id>; every scope but global can only tighten');
  return 0;
}

// ───────────────────────────── the first-run wizard (arming) ─────────────────────────────

/** The numbers the wizard asks for, in order. Everything else keeps its placeholder (shown) or stays off. */
export const WIZARD_KEYS: readonly LimitKey[] = ['perTradeSol', 'dailySol', 'buysPerDay', 'maxOpenPositions', 'dailyLossSol', 'executorSilenceMin'];

/**
 * No limits saved yet: ask for YOUR numbers on the real terminal (Enter keeps the placeholder shown in brackets).
 * Returns the `global` scope to save once the arming phrase is typed, or null (cancelled / not a terminal).
 */
export async function limitsWizard(io: AutotradeIo, deps: SignalDeps): Promise<LimitSet | null> {
  if (!isTty(io, deps)) return null;
  out(io, 'FIRST REAL RUN: set your own limits (they live outside the model; only you change them, on this terminal).');
  out(io, 'The numbers in brackets are placeholders, not advice. Enter keeps one; "off" turns a limit off.');
  const g: LimitSet = {};
  for (const k of WIZARD_KEYS) {
    const f = limitField(k)!;
    let done = false;
    for (let tries = 0; tries < 3 && !done; tries++) {
      const ans = await typedLine(io, deps, `  ${k}: ${f.help}\n    ${f.unit} [${DEFAULT_LIMITS[k] ?? 'off'}]: `);
      if (ans === null) return null;
      const t = ans.trim();
      if (!t) { g[k] = DEFAULT_LIMITS[k] ?? null; done = true; continue; }
      const p = parseLimitAssignment(`${k}=${t}`);
      if ('error' in p) { err(io, p.error); continue; }
      const issues = validateLimits({ ...emptyLimits(), global: { ...g, [k]: p.value } });
      const mine = issues.filter((i) => i.path === `/global/${k}`);
      if (mine.length) { err(io, mine.map((i) => i.msg).join('; ')); continue; }
      g[k] = p.value; done = true;
    }
    if (!done) { err(io, `no valid ${k}; nothing saved`); return null; }
  }
  for (const k of LIMIT_KEYS) if (!(k in g) && DEFAULT_LIMITS[k] !== undefined) g[k] = DEFAULT_LIMITS[k]!;
  return g;
}
