// Strategy + factory control from the in-app chat (task-2159). PAPER ONLY.
//
// What the chat can change (and nothing else):
//   on / off        the PAPER always-on switch of a strategy already on the always-on list (autotrade.json `enabled`);
//                   while the parallel run is active, off also pauses new entries now (open bags are kept and keep their
//                   exits) and on resumes / starts it at the next tick.
//   retire          a GENERATED strategy: marked retired, kept on disk, its forward test asked to stop, always-on off.
//   factory-pause   write FACTORY-STOP; factory-resume removes it; factory-run starts one run now (caps apply).
// There is no action for real mode, arming, caps, bankrolls or anything that signs or sends; asking for one is refused
// with a pointer to the explicit promotion flow on the user's own terminal.
//
// Every change is two steps. `preview` writes a pending change (pending/<code>.json) and returns what it would do.
// `confirm` applies it only when ALL hold:
//   - the call comes from the in-app chat (the app passes the chat turn by env: chat id, turn id, the user's own typed
//     text; the model cannot write that env, so it cannot forge a confirm);
//   - the pending change belongs to this chat and was made in an EARLIER turn (the model cannot preview and confirm in
//     one reply), and is at most 10 minutes old;
//   - the user's text for this turn confirms it: it names the code, or it is a short yes and this is the newest pending
//     change of the chat. A "no" / "cancel" cancels it.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fleetConfigPath, parseFleetConfig } from '../fleet-config.ts';
import { readFleetStatus, requestMemberControl, type ControlSource } from '../fleet-control.ts';
import { activeRunner } from '../safety.ts';
import { journeyView } from '../journey.ts';
import { writeJsonAtomic } from '../ledger.ts';
import type { StrategyStore } from '../store.ts';
import { agentPaused, clearAgentPause, clearFactoryStop, factoryBusy, factoryDir, factoryHalt, factoryStopped, writeAgentPause, writeFactoryStop } from './config.ts';
import { listGenerated, loadGenerated, retireGenerated } from './generate.ts';

export const CHANGE_ACTIONS = ['on', 'off', 'retire', 'factory-pause', 'factory-resume', 'factory-run'] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];
export const CHAT_TURN_ENV = 'DEXTERM_CHAT_TURN';
export const PENDING_TTL_MS = 10 * 60_000;
const ID = /^[a-z][a-z0-9-]{1,31}$/;

export const REAL_REFUSAL = 'The chat cannot touch real mode, arming, caps, bankrolls or anything that signs or sends. Real mode is the user\'s alone, on their own terminal: a finished forward test, then `dexterm autotrade promote <id> --to real` (evidence floor + your own caps) and `dexterm autotrade signal arm <id>` with a typed phrase. The chat only turns PAPER always-on strategies on or off.';

/** task-2170: `surface: 'web'` = the Strategy Builder web UI (its chat and its buttons). The web never writes or removes
 *  the user's FACTORY-STOP: its pause is a pause marker (AGENT-PAUSE, by `web`) and its resume lifts only that. */
export interface ChatTurn { chatId: string; turn: string; userText: string; surface?: 'web' }

/** The chat turn the app wrote into the environment (null outside the in-app chat). */
export function readChatTurn(env: NodeJS.ProcessEnv): ChatTurn | null {
  const raw = env[CHAT_TURN_ENV];
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.chatId !== 'string' || typeof j.turn !== 'string' || typeof j.userText !== 'string') return null;
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(j.chatId) || !/^[A-Za-z0-9_-]{1,64}$/.test(j.turn)) return null;
    return { chatId: j.chatId, turn: j.turn, userText: j.userText.slice(0, 2000), ...(j.surface === 'web' ? { surface: 'web' as const } : {}) };
  } catch { return null; }
}

export interface PendingChange {
  schema: 'dexterm-chat-change/1';
  code: string;
  action: ChangeAction;
  target: string | null;
  preview: string;
  chatId: string;
  turn: string;
  createdAt: number;
  status: 'pending' | 'applied' | 'cancelled' | 'expired' | 'refused';
  resolvedAt: number | null;
  result: string | null;
  /** task-2167: set when an MCP agent proposed it (`mcp:<client>`); chatId is then AGENT_CHAT_ID. */
  origin?: string;
  /** task-2170: previewed from the web UI (its pause/resume never touch FACTORY-STOP). */
  surface?: 'web';
}

export const pendingDir = (home: string): string => join(factoryDir(home), 'pending');
const pendingPath = (home: string, code: string): string => join(pendingDir(home), `${code}.json`);
export const newChangeCode = (): string => `C${randomBytes(3).toString('hex').toUpperCase()}`;

export function loadPending(home: string, code: string): PendingChange | null {
  if (!/^C[0-9A-F]{6}$/.test(code)) return null;
  const p = pendingPath(home, code);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as PendingChange; } catch { return null; }
}

function savePending(home: string, c: PendingChange): void { mkdirSync(pendingDir(home), { recursive: true, mode: 0o700 }); writeJsonAtomic(pendingPath(home, c.code), c); }

export function listPending(home: string, chatId?: string): PendingChange[] {
  const d = pendingDir(home);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => loadPending(home, f.slice(0, -5))).filter((x): x is PendingChange => !!x && (!chatId || x.chatId === chatId)).sort((a, b) => b.createdAt - a.createdAt);
}

// ───────────────────────────── what a change does ─────────────────────────────

interface MemberDoc { id: string; preset?: string; file?: string; mode?: string; enabled?: boolean; [k: string]: unknown }

/** The always-on member for a strategy id: the member whose preset is the id, else the member called the id. */
function readMembers(home: string): { ok: true; doc: { strategies: MemberDoc[]; [k: string]: unknown } } | { ok: false; why: string } {
  const path = fleetConfigPath(home);
  if (!existsSync(path)) return { ok: true, doc: { schema: 'dexterm-autotrade/1', strategies: [] } };
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (!doc || !Array.isArray(doc.strategies)) return { ok: false, why: 'autotrade.json has no strategies list' };
    return { ok: true, doc };
  } catch (e) { return { ok: false, why: `autotrade.json is not JSON (${(e as Error).message})` }; }
}

export function memberFor(home: string, id: string): MemberDoc | null {
  const r = readMembers(home);
  if (!r.ok) return null;
  return r.doc.strategies.find((m) => m.preset === id) ?? r.doc.strategies.find((m) => m.id === id) ?? null;
}

export type Check = { ok: true; preview: string } | { ok: false; why: string; real?: boolean };

/** Can this change be made, and what would it do (no writes). */
export function checkChange(home: string, store: StrategyStore, action: string, target: string | null, surface?: 'web'): Check {
  // task-2170: from the web UI, pause/resume use the pause marker only; FACTORY-STOP is the user's terminal switch
  if (surface === 'web' && action === 'factory-pause') { const h = factoryHalt(home); return h ? { ok: false, why: `the factory is already paused (${h.kind})` } : { ok: true, preview: 'pause the strategy factory from the web UI: writes a pause marker (AGENT-PAUSE, by web), so no scheduled or manual run starts until you resume it. Forward tests and strategies are not touched. The web UI never writes or removes FACTORY-STOP.' }; }
  if (surface === 'web' && action === 'factory-resume') {
    if (factoryStopped(home)) return { ok: false, why: 'the factory is stopped by FACTORY-STOP, your own switch: the web UI cannot remove it. Run `dexterm autotrade factory resume` in your terminal.' };
    return agentPaused(home) ? { ok: true, preview: 'resume the strategy factory: removes the pause marker (AGENT-PAUSE); the next scheduled run goes ahead within its caps.' } : { ok: false, why: 'the factory is not paused' };
  }
  if (/^(real|arm|live|disarm|signal|caps?|limits?|raise|bankroll|promote-real)$/i.test(action)) return { ok: false, why: REAL_REFUSAL, real: true };
  if (!(CHANGE_ACTIONS as readonly string[]).includes(action)) return { ok: false, why: `unknown change "${String(action).slice(0, 20)}": the chat can do ${CHANGE_ACTIONS.join(', ')}` };
  const a = action as ChangeAction;
  if (a === 'factory-pause') return factoryStopped(home) ? { ok: false, why: 'the factory is already paused (FACTORY-STOP exists)' } : { ok: true, preview: 'pause the strategy factory: writes FACTORY-STOP, so no scheduled or manual run starts until you resume it. Running forward tests and strategies are not touched.' };
  if (a === 'factory-resume') return factoryHalt(home) ? { ok: true, preview: `resume the strategy factory: removes ${factoryStopped(home) && agentPaused(home) ? 'FACTORY-STOP and an agent\'s pause' : factoryStopped(home) ? 'FACTORY-STOP' : 'an agent\'s pause (AGENT-PAUSE)'}; the next scheduled run (or "run the factory now") makes at most its capped number of paper candidates.` } : { ok: false, why: 'the factory is not paused' };
  if (a === 'factory-run') { const h = factoryHalt(home); if (h) return { ok: false, why: `the factory is paused (${h.kind}); resume it first` }; return { ok: true, preview: 'run the strategy factory now in the background: one analyst call per attempt within the per-run and per-day caps, at most the capped number of new PAPER candidates, each held-out tested and queued for a paper forward test. Nothing is promoted.' }; }
  if (!target || !ID.test(target)) return { ok: false, why: 'name a strategy id (strategy_overview lists them)' };
  const got = store.get(target);
  if (!got) return { ok: false, why: `no strategy ${target}` };
  if (got.ok && got.strategy.mode !== 'paper') return { ok: false, why: `${target} is mode ${got.strategy.mode}. ${REAL_REFUSAL}`, real: true };
  const m = memberFor(home, target);
  if (m && m.mode && m.mode !== 'paper') return { ok: false, why: `${target}'s always-on entry is not paper. ${REAL_REFUSAL}`, real: true };
  if (a === 'retire') {
    const g = loadGenerated(home, target);
    if (!g) return { ok: false, why: `${target} is not a generated strategy; retire is for the factory's candidates. To stop one of your own strategies, turn it off; \`dexterm autotrade remove ${target}\` removes it (journaled).` };
    if (g.stage === 'retired') return { ok: false, why: `${target} is already retired (${g.retired?.why ?? ''})` };
    return { ok: true, preview: `retire ${target} (GENERATED, ${g.stage}): marked retired and kept on disk with its report; its forward test is asked to stop (it flattens its paper positions)${m?.enabled !== false && m ? '; its always-on entry is turned off' : ''}. This cannot be undone from the chat.` };
  }
  if (!m) return { ok: false, why: `${target} is not on the always-on list, so there is nothing to turn ${a}. The way on is the promotion flow: a finished forward test, then strategy_promote_propose to always-on, which the user applies with y on the Q screen or \`dexterm autotrade promote apply <pp-id>\`.` };
  if (a === 'off') return m.enabled === false ? { ok: false, why: `${target} is already off` } : { ok: true, preview: `turn ${target} off: its always-on PAPER entry is disabled (it will not start with the parallel run)${fleetRunning(home) ? ', and the running one takes no new paper entries from its next tick; open bags are kept and keep their exits' : ''}.` };
  if (m.enabled !== false && !memberPaused(home, String(m.id))) return { ok: false, why: `${target} is already on` };
  return { ok: true, preview: `turn ${target} on: its always-on PAPER entry is enabled${fleetRunning(home) ? ' and it starts (or resumes entries) at the parallel run\'s next tick' : ' (it runs when the parallel run / always-on service starts)'}. Paper only, its own caps from autotrade.json.` };
}

function fleetRunning(home: string): boolean {
  const st = readFleetStatus(home);
  return st.ok && activeRunner(home)?.runId === st.status.fleetId;
}

function memberPaused(home: string, memberId: string): boolean {
  const st = readFleetStatus(home);
  if (!st.ok || activeRunner(home)?.runId !== st.status.fleetId) return false;
  return st.status.members.find((x) => x.id === memberId)?.state === 'paused';
}

export function previewChange(home: string, store: StrategyStore, action: string, target: string | null, o: { chat: ChatTurn | null; now?: number }): { ok: true; change: PendingChange } | { ok: false; why: string; real?: boolean } {
  const c = checkChange(home, store, action, target, o.chat?.surface);
  if (!c.ok) return c;
  if (!o.chat) return { ok: false, why: 'changes are confirmed in dexterm\'s in-app chat only (this session has no chat turn); the CLI does the same: dexterm autotrade factory …, dexterm autotrade pause/resume --strategy ID' };
  const now = o.now ?? Date.now();
  // one pending change per chat at a time: older ones expire
  for (const p of listPending(home, o.chat.chatId)) if (p.status === 'pending') savePending(home, { ...p, status: 'expired', resolvedAt: now, result: 'replaced by a newer change' });
  const change: PendingChange = { schema: 'dexterm-chat-change/1', code: newChangeCode(), action: action as ChangeAction, target: target ?? null, preview: c.preview, chatId: o.chat.chatId, turn: o.chat.turn, createdAt: now, status: 'pending', resolvedAt: null, result: null, ...(o.chat.surface === 'web' ? { surface: 'web' as const } : {}) };
  savePending(home, change);
  return { ok: true, change };
}

const YES = /^\s*(yes|y|yep|yeah|confirm(ed)?|do it|go ahead|ok(ay)?|sure|apply( it)?)\b[\s.!]*$/i;
// Any of these cancels, even next to the code ("cancel C1A2B3C" is a no). Erring towards cancel is the safe side.
const NO = /\b(no|not|nope|cancel|don['’]?t|stop|abort|wait|never ?mind)\b/i;

/** The code confirms only on its own or with a yes-word: "C1A2B3C", "yes C1A2B3C", "confirm C1A2B3C." (no other instructions). */
function namesCodeOnly(text: string, code: string): boolean {
  const up = text.toUpperCase();
  if (!up.includes(code)) return false;
  const rest = up.split(code).join(' ').replace(/[\s.,:;!"'`()-]+/g, ' ').trim();
  return rest === '' || YES.test(rest);
}

export interface ApplyDeps {
  /** Starts a factory run in the background (`dexterm autotrade factory run --by chat`); false = could not. */
  runFactory?: () => boolean;
}

export type ConfirmResult = { ok: true; applied: true; change: PendingChange; result: string } | { ok: false; applied: false; why: string; change?: PendingChange };

export function confirmChange(home: string, store: StrategyStore, code: string, o: { chat: ChatTurn | null; now?: number; deps?: ApplyDeps }): ConfirmResult {
  const now = o.now ?? Date.now();
  if (!o.chat) return { ok: false, applied: false, why: 'changes are confirmed in dexterm\'s in-app chat only' };
  const p = loadPending(home, code);
  // task-2167: an agent's proposal (chatId AGENT_CHAT_ID) is confirmed from any in-app chat, but only by its code in the user's own text
  const fromAgent = p?.chatId === AGENT_CHAT_ID;
  if (!p || (p.chatId !== o.chat.chatId && !fromAgent)) return { ok: false, applied: false, why: `no pending change ${String(code).slice(0, 10)} in this chat` };
  if (p.status !== 'pending') return { ok: false, applied: false, why: `change ${p.code} is ${p.status}`, change: p };
  if (now - p.createdAt > (fromAgent ? AGENT_PENDING_TTL_MS : PENDING_TTL_MS)) { const x = { ...p, status: 'expired' as const, resolvedAt: now }; savePending(home, x); return { ok: false, applied: false, why: `change ${p.code} expired (older than ${fromAgent ? '24 hours' : '10 minutes'}); ask again`, change: x }; }
  if (p.turn === o.chat.turn) return { ok: false, applied: false, why: 'the user has not answered yet: show the preview and ask them to confirm in their next message (a change is never confirmed in the same turn it was proposed)', change: p };
  const text = o.chat.userText;
  if (NO.test(text)) { const x = { ...p, status: 'cancelled' as const, resolvedAt: now, result: 'the user said no' }; savePending(home, x); return { ok: false, applied: false, why: 'the user declined; nothing changed', change: x }; }
  const newest = listPending(home, o.chat.chatId).find((x) => x.status === 'pending');
  const named = namesCodeOnly(text, p.code);
  const yes = !fromAgent && YES.test(text) && newest?.code === p.code;
  if (!named && !yes) return { ok: false, applied: false, why: fromAgent ? `the user's message does not name ${p.code}; an agent's proposal is confirmed only by its code in the user's own message ("confirm ${p.code}") or \`dexterm autotrade factory confirm ${p.code}\`; nothing changed` : `the user's message does not confirm ${p.code}; nothing changed. They confirm by replying "yes" (or the code ${p.code})`, change: p };
  // Re-check at apply time: the world may have moved since the preview.
  const web = p.surface === 'web' || o.chat.surface === 'web';
  const c = checkChange(home, store, p.action, p.target, web ? 'web' : undefined);
  if (!c.ok) { const x = { ...p, status: 'refused' as const, resolvedAt: now, result: c.why }; savePending(home, x); return { ok: false, applied: false, why: c.why, change: x }; }
  const r = applyChange(home, store, web ? { ...p, surface: 'web' } : p, now, o.deps ?? {}, { by: web ? 'web' : 'chat', why: fromAgent ? `confirmed by the user in the in-app chat (proposed by ${p.origin ?? 'an agent'})` : 'retired by the user from the in-app chat' });
  const x = { ...p, status: r.ok ? 'applied' as const : 'refused' as const, resolvedAt: now, result: r.ok ? r.result : r.why };
  savePending(home, x);
  return r.ok ? { ok: true, applied: true, change: x, result: r.result } : { ok: false, applied: false, why: r.why, change: x };
}

function setEnabled(home: string, id: string, enabled: boolean): { ok: true; memberId: string } | { ok: false; why: string } {
  const r = readMembers(home);
  if (!r.ok) return r;
  const m = r.doc.strategies.find((x) => x.preset === id) ?? r.doc.strategies.find((x) => x.id === id);
  if (!m) return { ok: false, why: `${id} is not on the always-on list` };
  if (m.mode && m.mode !== 'paper') return { ok: false, why: REAL_REFUSAL };
  m.enabled = enabled;
  const path = fleetConfigPath(home);
  const check = parseFleetConfig(r.doc, path);
  if (!check.ok) return { ok: false, why: `autotrade.json would not validate: ${check.errors.join('; ')}` };
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  writeJsonAtomic(path, r.doc);
  return { ok: true, memberId: String(m.id) };
}

/** Who applies a change (journal / stop-file actor) and why; the chat passes 'chat', the user's terminal 'cli', an agent `mcp:<client>`. */
interface ApplyBy { by: string; why: string }
const controlSource = (by: string): ControlSource => (by.startsWith('mcp:') ? 'mcp' : by === 'cli' ? 'cli' : 'chat');

function applyChange(home: string, store: StrategyStore, p: PendingChange, now: number, deps: ApplyDeps, who: ApplyBy = { by: 'chat', why: 'retired by the user from the in-app chat' }): { ok: true; result: string } | { ok: false; why: string } {
  switch (p.action) {
    case 'factory-pause': if (p.surface === 'web') { writeAgentPause(home, 'web', 'paused from the web UI', now); return { ok: true, result: 'the factory is paused (pause marker AGENT-PAUSE, by web); resume it from the web UI or the terminal' }; }
      writeFactoryStop(home, who.by, `paused from the ${who.by === 'cli' ? 'terminal' : 'in-app chat'}`, now); return { ok: true, result: 'the factory is paused (FACTORY-STOP written); nothing else changed' };
    case 'factory-resume': if (p.surface === 'web') { if (factoryStopped(home)) return { ok: false, why: 'FACTORY-STOP exists: the web UI cannot remove it (`dexterm autotrade factory resume` in your terminal)' }; clearAgentPause(home); return { ok: true, result: 'the factory is resumed (pause marker removed); the next scheduled run goes ahead within its caps' }; }
    { const s = clearFactoryStop(home); const a = clearAgentPause(home); return { ok: true, result: `the factory is resumed (${[s ? 'FACTORY-STOP' : '', a ? 'AGENT-PAUSE' : ''].filter(Boolean).join(' and ')} removed); the next scheduled run goes ahead within its caps` }; }
    case 'factory-run': return deps.runFactory?.() ? { ok: true, result: 'a factory run started in the background; `factory_status` shows it when it ends (usually a few minutes)' } : { ok: false, why: 'could not start a factory run from here; run `dexterm autotrade factory run` in a terminal' };
    case 'retire': {
      const target = p.target!;
      const m = memberFor(home, target);
      let extra = '';
      if (m && m.enabled !== false) { const e = setEnabled(home, target, false); if (e.ok) { extra = '; its always-on entry is off'; if (fleetRunning(home)) requestMemberControl(home, e.memberId, 'pause', controlSource(who.by), now); } }
      const r = retireGenerated(home, target, who.by, who.why, now);
      return r.ok ? { ok: true, result: `${target} is retired (kept on disk with its report)${r.report.forward.forwardId ? '; its forward test was asked to stop' : ''}${extra}` } : { ok: false, why: r.why };
    }
    case 'on':
    case 'off': {
      const target = p.target!;
      const e = setEnabled(home, target, p.action === 'on');
      if (!e.ok) return e;
      let live = '';
      if (fleetRunning(home)) {
        const paused = memberPaused(home, e.memberId);
        const action = p.action === 'off' ? 'pause' : paused ? 'resume-entries' : 'start';
        const w = requestMemberControl(home, e.memberId, action, controlSource(who.by), now);
        live = w.ok ? (p.action === 'off' ? '; the running one takes no new paper entries from its next tick (open bags kept, exits keep running)' : `; the parallel run ${action === 'start' ? 'starts it' : 'resumes its entries'} at its next tick`) : `; the running parallel run did not take the request: ${w.why}`;
      }
      return { ok: true, result: `${target} is ${p.action} (autotrade.json enabled: ${p.action === 'on'}, paper)${live}` };
    }
  }
}

// ───────────────────────────── MCP agents (task-2167) ─────────────────────────────
//
// The same checks and the same apply path as the chat, with the agent's own rules:
//   DIRECT (the precedent: strategy_forward_stop / autotrade_parallel_stop act at once, always towards less activity)
//     factory pause    writes AGENT-PAUSE, never FACTORY-STOP; undo: factory resume (agent or user)
//     factory resume   removes only AGENT-PAUSE; the user's FACTORY-STOP stays and becomes a proposal for the user
//     retire           a GENERATED candidate only (never a preset or the user's own); undo: `factory unretire <id>` (user)
//   PROPOSAL (autotrade.json is the user's file, and the chat itself confirms these): on / off, resume past FACTORY-STOP.
//     A pending change with chatId AGENT_CHAT_ID; it applies only when the user names its code in the in-app chat or
//     runs `dexterm autotrade factory confirm <code>` on their own terminal. 24 h to live, at most 10 waiting.
//   run now: checked here (halts, lock), rate-limited by the MCP layer; the run itself enforces every cap.

export const AGENT_CHAT_ID = 'agent'; // shorter than any chat id readChatTurn accepts: a chat can never be "agent"
export const AGENT_PENDING_TTL_MS = 24 * 3600_000;
export const AGENT_PENDING_MAX = 10;
export const AGENT_PROPOSE_ACTIONS = ['on', 'off', 'factory-resume', 'retire'] as const;
export const AGENT_DIRECT_ACTIONS = ['factory-pause', 'factory-resume', 'retire'] as const;
const AGENT_BY = /^mcp:[a-z0-9][a-z0-9._-]{0,40}$/;

export type AgentProposal = { ok: true; change: PendingChange; existing: boolean } | { ok: false; why: string; real?: boolean };

/** An agent asks for a change only the user may apply: a pending change the user confirms by its code. */
export function proposeAgentChange(home: string, store: StrategyStore, action: string, target: string | null, o: { by: string; now?: number }): AgentProposal {
  if (!AGENT_BY.test(o.by)) return { ok: false, why: 'bad agent id' };
  if (!(AGENT_PROPOSE_ACTIONS as readonly string[]).includes(action)) { const c = checkChange(home, store, action, target); return c.ok ? { ok: false, why: `an agent cannot propose "${action}"` } : c; }
  const c = checkChange(home, store, action, target);
  if (!c.ok) return c;
  const now = o.now ?? Date.now();
  const waiting = listPending(home, AGENT_CHAT_ID).filter((p) => p.status === 'pending' && now - p.createdAt <= AGENT_PENDING_TTL_MS);
  const dup = waiting.find((p) => p.action === action && p.target === (target ?? null));
  if (dup) return { ok: true, change: dup, existing: true };
  if (waiting.length >= AGENT_PENDING_MAX) return { ok: false, why: `${waiting.length} agent proposals already wait for the user (at most ${AGENT_PENDING_MAX}); they expire after 24 h` };
  const change: PendingChange = { schema: 'dexterm-chat-change/1', code: newChangeCode(), action: action as ChangeAction, target: target ?? null, preview: c.preview, chatId: AGENT_CHAT_ID, turn: o.by, createdAt: now, status: 'pending', resolvedAt: null, result: null, origin: o.by };
  savePending(home, change);
  return { ok: true, change, existing: false };
}

export type AgentActResult = { ok: true; changed: string; undo: string; proposal?: PendingChange; /** false when nothing was written (only a proposal, or already so) */ applied?: boolean } | { ok: false; why: string; real?: boolean };

/** The direct agent actions: each says what changed and how to undo it. */
export function agentAct(home: string, store: StrategyStore, action: string, target: string | null, o: { by: string; why?: string; now?: number }): AgentActResult {
  if (!AGENT_BY.test(o.by)) return { ok: false, why: 'bad agent id' };
  const now = o.now ?? Date.now();
  if (action === 'factory-pause') {
    const h = factoryHalt(home);
    if (h) return { ok: true, changed: `nothing: the factory is already paused (${h.kind} by ${h.info.by})`, undo: h.kind === 'AGENT-PAUSE' ? 'factory_resume' : 'only the user lifts FACTORY-STOP (`dexterm autotrade factory resume`, or "resume the factory" in the in-app chat)' };
    writeAgentPause(home, o.by, (o.why ?? 'paused by an agent').slice(0, 200), now);
    return { ok: true, changed: 'the factory is paused: AGENT-PAUSE written (no scheduled or manual run starts; forward tests and strategies are not touched)', undo: 'factory_resume, or the user: `dexterm autotrade factory resume`' };
  }
  if (action === 'factory-resume') {
    const lifted = clearAgentPause(home);
    if (factoryStopped(home)) {
      const pr = proposeAgentChange(home, store, 'factory-resume', null, { by: o.by, now });
      return { ok: true, applied: lifted, changed: `${lifted ? 'AGENT-PAUSE removed; ' : ''}FACTORY-STOP is the user's and stays: an agent cannot lift it${pr.ok ? `. A resume proposal ${pr.change.code} waits for the user` : ''}`, undo: lifted ? 'factory_pause' : 'nothing changed', ...(pr.ok ? { proposal: pr.change } : {}) };
    }
    return lifted ? { ok: true, changed: 'the factory is resumed (AGENT-PAUSE removed); the next scheduled run goes ahead within its caps', undo: 'factory_pause' } : { ok: true, changed: 'nothing: the factory was not paused', undo: 'nothing changed' };
  }
  if (action === 'retire') {
    const c = checkChange(home, store, 'retire', target);
    if (!c.ok) return c;
    // task-2167 r1 (verifier task-2173): a candidate the USER put on the always-on list is theirs to take off. Retiring it
    // would write autotrade.json, so it waits for the user like on/off; a candidate with no enabled always-on entry is
    // retired at once (factory + forward-test files only).
    const m = memberFor(home, target!);
    if (m && m.enabled !== false) {
      const pr = proposeAgentChange(home, store, 'retire', target, { by: o.by, now });
      if (!pr.ok) return pr;
      return { ok: true, applied: false, changed: `nothing yet: ${target} is on your always-on list, so retiring it (which also turns that entry off) waits for you as proposal ${pr.change.code}`, undo: `nothing changed; \`dexterm autotrade factory confirm ${pr.change.code} --cancel\` drops the proposal`, proposal: pr.change };
    }
    const p: PendingChange = { schema: 'dexterm-chat-change/1', code: 'C000000', action: 'retire', target, preview: c.preview, chatId: AGENT_CHAT_ID, turn: o.by, createdAt: now, status: 'pending', resolvedAt: null, result: null, origin: o.by };
    const r = applyChange(home, store, p, now, {}, { by: o.by, why: `retired by ${o.by}: ${(o.why ?? 'no reason given').slice(0, 200)}` });
    return r.ok ? { ok: true, changed: r.result, undo: `the user: \`dexterm autotrade factory unretire ${target}\` (queues it for a forward test again; its always-on entry stays off)` } : { ok: false, why: r.why };
  }
  const c = checkChange(home, store, action, target);
  return c.ok ? { ok: false, why: `an agent cannot "${action}" directly${(AGENT_PROPOSE_ACTIONS as readonly string[]).includes(action) ? ': it is a proposal the user confirms' : ''}` } : c;
}

/** Can an agent start a factory run now (rate limits live in the MCP layer; the run enforces every cap itself)? */
export function agentRunCheck(home: string, now = Date.now()): { ok: true } | { ok: false; why: string } {
  const h = factoryHalt(home);
  if (h) return { ok: false, why: `the factory is paused (${h.kind} by ${h.info.by})${h.kind === 'FACTORY-STOP' ? '; only the user resumes it' : '; factory_resume lifts an agent pause'}` };
  if (factoryBusy(home, now)) return { ok: false, why: 'a factory run is already going (one at a time); factory_status shows it when it ends' };
  return { ok: true };
}

/** The user's own terminal confirms (or cancels) an agent's proposal by its code. */
export function confirmAgentChange(home: string, store: StrategyStore, code: string, o: { cancel?: boolean; now?: number; deps?: ApplyDeps }): ConfirmResult {
  const now = o.now ?? Date.now();
  const p = loadPending(home, code);
  if (!p || p.chatId !== AGENT_CHAT_ID) return { ok: false, applied: false, why: `no agent proposal ${String(code).slice(0, 10)} (\`dexterm autotrade factory pending\` lists them)` };
  if (p.status !== 'pending') return { ok: false, applied: false, why: `change ${p.code} is ${p.status}`, change: p };
  if (now - p.createdAt > AGENT_PENDING_TTL_MS) { const x = { ...p, status: 'expired' as const, resolvedAt: now }; savePending(home, x); return { ok: false, applied: false, why: `change ${p.code} expired (older than 24 hours)`, change: x }; }
  if (o.cancel) { const x = { ...p, status: 'cancelled' as const, resolvedAt: now, result: 'the user cancelled it on the terminal' }; savePending(home, x); return { ok: false, applied: false, why: 'cancelled; nothing changed', change: x }; }
  const c = checkChange(home, store, p.action, p.target);
  if (!c.ok) { const x = { ...p, status: 'refused' as const, resolvedAt: now, result: c.why }; savePending(home, x); return { ok: false, applied: false, why: c.why, change: x }; }
  const r = applyChange(home, store, p, now, o.deps ?? {}, { by: 'cli', why: `confirmed by the user on the terminal (proposed by ${p.origin ?? 'an agent'})` });
  const x = { ...p, status: r.ok ? 'applied' as const : 'refused' as const, resolvedAt: now, result: r.ok ? r.result : r.why };
  savePending(home, x);
  return r.ok ? { ok: true, applied: true, change: x, result: r.result } : { ok: false, applied: false, why: r.why, change: x };
}

// ───────────────────────────── the overview the chat reads ─────────────────────────────

export interface OverviewRow {
  id: string; name: string; source: 'preset' | 'user' | 'generated'; mode: string; paper: boolean;
  on: boolean | null; running: string | null; stage: string; generated: { stage: string; parents: string[] } | null;
  lastBacktest: string | null;
}

/** Every strategy: where it comes from, whether its always-on switch is on, its ladder stage, generated status. */
export function strategyOverview(home: string, store: StrategyStore): OverviewRow[] {
  const gens = new Map(listGenerated(home).map((g) => [g.id, g]));
  const st = readFleetStatus(home);
  const live = st.ok && activeRunner(home)?.runId === st.status.fleetId ? st.status : null;
  const out: OverviewRow[] = [];
  for (const e of store.list()) {
    const got = store.get(e.id);
    const g = gens.get(e.id);
    const m = memberFor(home, e.id);
    const lm = live?.members.find((x) => x.id === (m?.id ?? e.id));
    let stage = e.ok ? 'draft' : 'invalid';
    if (got?.ok && e.source === 'user') { try { stage = journeyView(home, got.strategy, {}).stage; } catch { /* unreadable journey */ } }
    if (e.source === 'preset') stage = 'preset';
    out.push({
      id: e.id, name: e.name ?? e.id, source: g ? 'generated' : e.source, mode: e.mode ?? 'paper', paper: (e.mode ?? 'paper') === 'paper',
      on: m ? m.enabled !== false : null, running: lm ? lm.state : null, stage,
      generated: g ? { stage: g.stage, parents: g.parents } : null,
      lastBacktest: e.lastBacktest ? `${e.lastBacktest.trades} trades, net ${e.lastBacktest.netPct}%` : null,
    });
  }
  return out;
}

