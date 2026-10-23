// `dexterm telegram …` (task-1527, AUTOTRADE-SPEC §8.3): your OWN Telegram bot for the autotrade runner.
//
//   setup      read the bot token with a hidden prompt (or from a pipe), check it with getMe (prints the bot's
//              username only), store it in the OS secret store (macOS keychain, Linux libsecret) or a 0600 file
//              under ~/.dexterm/secrets/, then pair. The token never goes in a config file, a log, argv or env.
//   pair       a 6-digit code on THIS screen, valid 5 minutes; send `/pair <code>` to the bot from your own account
//              in a private chat. Refused while a webhook or a 409 conflict shows someone else polling the bot (they
//              could read the code); the account that sent it (@username + id) is shown here and needs a local y/N.
//              Only that account in that chat is allowed; the bot answers nobody else.
//   status     what is set up (never the token), the paired chats, approvals, notify settings, the audit chain.
//   approvals  on|off (local; chat can only turn them on). notify <event> on|off. set summary-at|quiet|expiry.
//   test       send one test message to the paired chats (the manual smoke test; nothing in CI talks to Telegram).
//   audit      [--verify] the chat audit chain (autotrade/chat/<day>.jsonl).
//   revoke     remove the token from the store and forget every paired chat.
// The runner starts the bot by itself when it is set up and paired (`dexterm autotrade run … --paper`; --no-telegram
// keeps it off). Nothing here is hosted: the bot long-polls from this machine.

import { dextermHome } from '@dexterm/custom';
import {
  ChatAudit, PairingWindow, TelegramConnector, TIERS_ALL, chooseSecretStore, connectorsPath, defaultTelegram, loadConnectors, looksLikeBotToken, redact, saveConnectors,
  secretStore, verifyChatAudit, ChatHub, type ConnectorsConfig, type SecretStore, type Tier, type ChatConnector,
} from '@dexterm/autotrade';

export interface TelegramIo {
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream | (import('./wallet-cmd.ts').KeyInput & { setEncoding?(e: string): unknown; on?(ev: string, cb: (x: never) => void): unknown });
}

type BotConnector = ChatConnector & {
  getMe?: () => Promise<{ id: string; username: string }>;
  /** 'clear' only when Telegram answered and no webhook is set (TelegramConnector). */
  checkWebhook?: () => Promise<'clear' | 'webhook' | 'unknown'>;
  confirmOffset?: () => Promise<void>;
};

/** Test seams: a connector instead of the real Bot API, a secret store, a token reader, the local y/N, a clock. */
export interface TelegramDeps {
  connector?: (token: () => string | null) => BotConnector;
  store?: SecretStore;
  readToken?: () => Promise<string | null>;
  /** The local y/N that confirms which account sent the pairing code (default: a line on this terminal). */
  confirm?: (question: string) => Promise<boolean>;
  now?: () => number;
  pairTimeoutMs?: number;
}

export const TELEGRAM_USAGE = `dexterm telegram: your own Telegram bot for the autotrade runner (paper first). Nothing is hosted.

  dexterm telegram setup [--tiers notify,control,approve] [--no-pair]
      store your bot token (hidden prompt or a pipe; never an argument), check it, then pair your account
  dexterm telegram pair [--tiers notify,control,approve]
      show a one-time code here; send /pair <code> to your bot from your own private chat (5 minutes)
  dexterm telegram status [--json]
  dexterm telegram approvals on|off
      on: every entry waits for your tap (chat can turn this on, never off)
  dexterm telegram notify candidates digest|each|off · notify entries|closes|halts|spend|daily on|off
  dexterm telegram set summary-at HH:MM|off · set quiet HH:MM-HH:MM|off · set expiry 60..120
  dexterm telegram test        send one test message to your paired chat (manual check)
  dexterm telegram audit [--verify]
  dexterm telegram revoke      remove the token and forget every paired chat

  Telegram is not end-to-end encrypted: the bot never sends keys, seed phrases, wallet addresses or balances,
  and it never asks for them. The bot is your OWN bot for alerts and control of PAPER runs: dexterm holds no key and places
  no live order (live trading happens in the Telegram trading bot of your choice). Experimental; not financial advice.
`;

const flag = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function parseTiers(v: string | undefined): Tier[] | null {
  if (!v) return [...TIERS_ALL];
  const xs = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!xs.length || xs.some((x) => !(TIERS_ALL as readonly string[]).includes(x))) return null;
  return [...new Set(xs)] as Tier[];
}

/** Hidden input on a real terminal (nothing echoed), or the first line of a pipe. Never an argument or env var. */
export async function readHidden(io: TelegramIo, prompt: string): Promise<string | null> {
  const stdin = io.stdin as (NodeJS.ReadStream | undefined);
  if (!stdin) return null;
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    io.stderr.write(prompt);
    return new Promise((resolve) => {
      let buf = '';
      const done = (v: string | null) => { try { stdin.setRawMode(false); } catch { /* ignore */ } stdin.off('data', onData); stdin.pause(); io.stderr.write('\n'); resolve(v); };
      const onData = (chunk: Buffer | string) => {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\r' || ch === '\n') { done(buf.trim() || null); return; }
          if (ch === '\u0003' || ch === '\u001b') { done(null); return; }
          if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
          if (ch >= ' ') buf += ch;
        }
      };
      stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
    });
  }
  return pipeLine(stdin);
}

/** A pipe is read once to its end; its later lines answer later questions (`printf '%s\ny\n' "$TOKEN" | … setup`). */
const pipeRest = new WeakMap<object, Promise<string[]>>();
async function pipeLine(stdin: NodeJS.ReadStream): Promise<string | null> {
  let lines = pipeRest.get(stdin);
  if (!lines) {
    lines = new Promise((resolve) => {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c: string) => { buf += c; });
      stdin.on('end', () => resolve(buf.split('\n')));
      stdin.on('error', () => resolve([]));
    });
    pipeRest.set(stdin, lines);
  }
  const l = (await lines).shift();
  return l === undefined ? null : l.trim() || null;
}

/** One visible line from this terminal (or the next line of a pipe); null when there is no input. */
async function readLine(io: TelegramIo, prompt: string): Promise<string | null> {
  const stdin = io.stdin as (NodeJS.ReadStream | undefined);
  if (!stdin) return null;
  io.stderr.write(prompt);
  if (!stdin.isTTY) { const l = await pipeLine(stdin); io.stderr.write('\n'); return l; }
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: stdin, terminal: false });
  try {
    return await new Promise<string | null>((resolve) => { rl.once('line', (l) => resolve(l.trim())); rl.once('close', () => resolve(null)); });
  } finally { rl.close(); stdin.pause(); }
}

/** The account as Telegram reports it, safe to print: a handle is [A-Za-z0-9_] only; a display name loses controls. */
export function describeSender(senderId: string, sender?: { username?: string; name?: string }): string {
  const handle = sender?.username && /^[A-Za-z0-9_]{1,32}$/.test(sender.username) ? `@${sender.username}` : '(no @username)';
  // eslint-disable-next-line no-control-regex
  const name = (sender?.name ?? '').replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, '').trim().slice(0, 64);
  return `${handle} (id ${senderId}${name ? `, name ${JSON.stringify(name)}` : ''})`;
}

const CONFLICT_HELP = 'Someone else may hold your bot token (and may have read the code). Revoke it in @BotFather (/revoke), then run `dexterm telegram setup` with the new token.';

function load(home: string, io: TelegramIo): ConnectorsConfig | null {
  const r = loadConnectors(home);
  if (!r.ok) { io.stderr.write(`dexterm telegram: ${r.error}\n`); return null; }
  return r.config;
}

function storeOf(home: string, cfg: ConnectorsConfig, io: TelegramIo, deps: TelegramDeps): SecretStore {
  if (deps.store) return deps.store;
  return cfg.telegram.secretStore ? secretStore(cfg.telegram.secretStore, home) : chooseSecretStore(home, io.env);
}

function connectorFor(deps: TelegramDeps, token: () => string | null, io: TelegramIo) {
  return deps.connector ? deps.connector(token) : new TelegramConnector({ token, onLog: (l) => io.stderr.write(`telegram: ${l}\n`) });
}

async function pairFlow(home: string, io: TelegramIo, deps: TelegramDeps, tiers: Tier[]): Promise<number> {
  const cfg = load(home, io);
  if (!cfg) return 1;
  const store = storeOf(home, cfg, io, deps);
  const token = store.get();
  if (!token) { io.stderr.write('dexterm telegram: no bot token yet: run `dexterm telegram setup`\n'); return 1; }
  const now = deps.now ?? Date.now;
  const conn = connectorFor(deps, () => token, io);
  const audit = new ChatAudit(home, { knownToken: () => token });
  // 1. Nobody else may be reading this bot: a webhook (or an unanswered check) refuses before a code exists.
  const hook = conn.checkWebhook ? await conn.checkWebhook() : 'clear';
  if (hook !== 'clear' || conn.health().conflict) {
    audit.add(now(), 'pairing_refused', { why: hook === 'clear' ? 'conflict' : `webhook-${hook}` });
    io.stderr.write(hook === 'unknown'
      ? 'dexterm telegram: could not check the bot with Telegram (getWebhookInfo); nothing was paired. Try again.\n'
      : `dexterm telegram: NOT pairing: ${conn.health().conflict ?? 'a webhook is set on this bot'}. ${CONFLICT_HELP}\n`);
    return 1;
  }
  const win = new PairingWindow({ now });
  const hub = new ChatHub({ connector: conn, config: () => cfg.telegram, audit, badge: 'PAPER', now });
  const ac = new AbortController();
  let paired: { senderId: string; chatId: string; sender?: { username?: string; name?: string } } | null = null;
  hub.openPairing(win, (r, c) => { if (r.ok) { paired = { senderId: r.senderId, chatId: r.chatId, sender: c.sender }; ac.abort(); } else if (r.why === 'locked' || r.why === 'conflict') ac.abort(); });
  io.stdout.write(`Pairing code: ${win.code.slice(0, 3)} ${win.code.slice(3)}\n`);
  io.stdout.write(`Open a PRIVATE chat with ${cfg.telegram.bot ? `@${cfg.telegram.bot.username}` : 'your bot'} from your own account and send:\n  /pair ${win.code}\n`);
  io.stdout.write('The code is valid for 5 minutes and works once. Waiting… (Ctrl-C to stop)\n');
  const limit = setTimeout(() => ac.abort(), deps.pairTimeoutMs ?? Math.max(0, win.expiresAt - now()));
  limit.unref?.();
  // 2. A 409 (another getUpdates poll) at any point in the window ends it: that poller may have read the code.
  const watch = setInterval(() => { if (conn.health().conflict) ac.abort(); }, 100);
  watch.unref?.();
  const onSig = () => ac.abort();
  process.once('SIGINT', onSig);
  try {
    await conn.start(ac.signal);
    await hub.idle();
  } finally {
    clearTimeout(limit);
    clearInterval(watch);
    process.removeListener('SIGINT', onSig);
  }
  // Confirm the update offset, so the runner's first poll does not see the /pair message again.
  try { await conn.confirmOffset?.(); } catch { /* best effort */ }
  const conflict = conn.health().conflict;
  if (conflict) {
    audit.add(now(), 'pairing_refused', { why: 'conflict', codeAccepted: paired !== null });
    io.stderr.write(`dexterm telegram: NOT paired: ${conflict}. ${CONFLICT_HELP}\n`);
    return 1;
  }
  if (!paired) { io.stderr.write('dexterm telegram: not paired (the code expired, was wrong too often, or you stopped). Run `dexterm telegram pair` again.\n'); return 1; }
  const p = paired as { senderId: string; chatId: string; sender?: { username?: string; name?: string } };
  // 3. The code is a shared secret that travelled through Telegram: the person at this computer says whose account it is.
  const who = describeSender(p.senderId, p.sender);
  io.stdout.write(`The code came from ${who}, in its private chat with the bot.\n`);
  const question = `Is ${who} YOUR Telegram account? It gets ${tiers.join(', ')}. [y/N] `;
  const yes = deps.confirm ? await deps.confirm(question) : /^(y|yes)$/i.test((await readLine(io, question)) ?? '');
  if (!yes) {
    audit.add(now(), 'pairing_refused', { why: 'not-confirmed-locally', senderId: p.senderId });
    io.stderr.write(`dexterm telegram: not paired. If that account is not yours, someone else has your bot token. ${CONFLICT_HELP}\n`);
    return 1;
  }
  // A conflict or a webhook that showed up while the question was open counts too.
  const late = conn.health().conflict ?? (conn.checkWebhook && (await conn.checkWebhook()) !== 'clear' ? (conn.health().conflict ?? 'the bot could not be checked again') : null);
  if (late) {
    audit.add(now(), 'pairing_refused', { why: 'conflict-after-confirm' });
    io.stderr.write(`dexterm telegram: NOT paired: ${late}. ${CONFLICT_HELP}\n`);
    return 1;
  }
  const next = load(home, io) ?? cfg;
  next.telegram.allow = [...next.telegram.allow.filter((a) => !(a.senderId === p.senderId && a.chatId === p.chatId)), { senderId: p.senderId, chatId: p.chatId, tiers, pairedAt: now() }];
  next.telegram.enabled = true;
  saveConnectors(home, next);
  audit.add(now(), 'paired', { senderId: p.senderId, chatId: p.chatId, tiers });
  try {
    const ref = await conn.send({ chatId: p.chatId }, { kind: 'text', badge: 'PAPER', lines: ['Paired with dexterm on your computer. /help lists the commands. I never ask for keys or seed phrases.'] });
    audit.add(now(), 'out', { template: 'paired', chatId: p.chatId, messageId: ref.messageId });
  } catch { /* the pairing is saved; the chat note is a courtesy */ }
  io.stdout.write(`✓ paired: ${who} in its private chat, tiers ${tiers.join(', ')}. The bot answers nobody else.\n`);
  io.stdout.write('The runner starts the bot by itself: dexterm autotrade run <strategy> --paper. Turn on Telegram two-step verification for your account.\n');
  return 0;
}

export async function telegramCommand(argv: string[], io: TelegramIo, deps: TelegramDeps = {}): Promise<number> {
  const sub = argv[0];
  const home = dextermHome(io.env);
  try {
    switch (sub) {
      case undefined: case 'help': case '--help': case '-h': io.stdout.write(TELEGRAM_USAGE); return 0;

      case 'setup': {
        const tiers = parseTiers(flag(argv, '--tiers'));
        if (!tiers) { io.stderr.write('dexterm telegram: --tiers takes notify,control,approve\n'); return 2; }
        if (argv.slice(1).some((a) => looksLikeBotToken(a))) { io.stderr.write('dexterm telegram: never pass the token as an argument (it would land in your shell history); run setup and paste it at the prompt\n'); return 2; }
        const cfg = load(home, io);
        if (!cfg) return 1;
        io.stdout.write('1. In Telegram, open @BotFather, send /newbot, and copy the token it gives you.\n2. Paste it below (nothing is shown while you type).\n');
        const token = await (deps.readToken ? deps.readToken() : readHidden(io, 'bot token: '));
        if (!token) { io.stderr.write('dexterm telegram: no token given\n'); return 2; }
        if (!looksLikeBotToken(token)) { io.stderr.write('dexterm telegram: that does not look like a bot token (digits, a colon, then about 35 letters, digits, - or _)\n'); return 2; }
        const conn = connectorFor(deps, () => token, io);
        let me: { id: string; username: string };
        try {
          if (!conn.getMe) throw new Error('this connector cannot check a token');
          me = await conn.getMe();
        } catch (e) { io.stderr.write(`dexterm telegram: the token did not work: ${redact((e as Error).message, token)}\n`); return 1; }
        const store = deps.store ?? chooseSecretStore(home, io.env);
        store.set(token);
        cfg.telegram = { ...cfg.telegram, bot: { id: me.id, username: me.username }, secretStore: store.kind === 'memory' ? 'file' : store.kind, enabled: cfg.telegram.allow.length > 0 };
        saveConnectors(home, cfg);
        io.stdout.write(`✓ bot @${me.username} checked; token stored in ${store.kind === 'keychain' ? 'the macOS keychain' : store.kind === 'libsecret' ? 'the system keyring (libsecret)' : store.kind === 'file' ? 'a 0600 file under your dexterm home (secrets/)' : 'memory'}. Config: ${connectorsPath(home)} (no secrets in it).\n`);
        if (argv.includes('--no-pair')) { io.stdout.write('Pair later: dexterm telegram pair\n'); return 0; }
        return pairFlow(home, io, deps, tiers);
      }

      case 'pair': {
        const tiers = parseTiers(flag(argv, '--tiers'));
        if (!tiers) { io.stderr.write('dexterm telegram: --tiers takes notify,control,approve\n'); return 2; }
        return pairFlow(home, io, deps, tiers);
      }

      case 'status': {
        const cfg = load(home, io);
        if (!cfg) return 1;
        const t = cfg.telegram;
        const store = t.secretStore ? (deps.store ?? secretStore(t.secretStore, home)) : null;
        const hasToken = store ? store.get() !== null : false;
        const chain = verifyChatAudit(home);
        const view = {
          enabled: t.enabled, bot: t.bot ? `@${t.bot.username}` : null, tokenStored: hasToken, secretStore: t.secretStore, tiers: t.tiers,
          paired: t.allow.map((a) => ({ senderId: a.senderId, chatId: a.chatId, tiers: a.tiers, pairedAt: a.pairedAt ? new Date(a.pairedAt).toISOString() : null })),
          approvals: t.approvals, approvalExpirySec: t.approvalExpirySec, repriceTolPct: t.repriceTolPct, notify: t.notify, dailySummaryAt: t.dailySummaryAt, quietHours: t.quietHours,
          audit: { days: chain.length, broken: chain.filter((c) => !c.check.ok).map((c) => c.day) },
        };
        if (argv.includes('--json')) { io.stdout.write(`${JSON.stringify(view, null, 2)}\n`); return 0; }
        io.stdout.write(`telegram · ${t.enabled && t.allow.length && hasToken ? 'ready (the runner starts it)' : 'not ready'}\n`);
        io.stdout.write(`  bot ${view.bot ?? '(not set up)'} · token ${hasToken ? `stored (${t.secretStore})` : 'missing'}\n`);
        io.stdout.write(`  paired ${t.allow.length ? t.allow.map((a) => `id ${a.senderId} [${a.tiers.join(',')}]`).join('; ') : 'nobody (dexterm telegram pair)'}\n`);
        io.stdout.write(`  approvals ${t.approvals} · expiry ${t.approvalExpirySec} s · re-quote tolerance ${t.repriceTolPct}%\n`);
        io.stdout.write(`  notify candidates ${t.notify.candidates} · entries ${t.notify.entries ? 'on' : 'off'} · closes ${t.notify.closes ? 'on' : 'off'} · halts ${t.notify.halts ? 'on' : 'off'} · spend ${t.notify.spend ? 'on' : 'off'} · daily ${t.notify.daily ? `at ${t.dailySummaryAt ?? 'off'}` : 'off'}${t.quietHours ? ` · quiet ${t.quietHours}` : ''}\n`);
        io.stdout.write(`  audit ${chain.length} day file${chain.length === 1 ? '' : 's'}${view.audit.broken.length ? ` · BROKEN: ${view.audit.broken.join(', ')}` : ''}\n`);
        return 0;
      }

      case 'approvals': {
        const v = argv[1];
        if (v !== 'on' && v !== 'off') { io.stderr.write('dexterm telegram: approvals on|off\n'); return 2; }
        const cfg = load(home, io);
        if (!cfg) return 1;
        cfg.telegram.approvals = v;
        saveConnectors(home, cfg);
        io.stdout.write(v === 'on' ? 'approvals on: every new entry waits for a tap in your paired chat (no answer = skip)\n' : 'approvals off: entries follow the strategy (`entry.decide: "agent+approve"` still asks every time)\n');
        return 0;
      }

      case 'notify': {
        const ev = argv[1]; const v = argv[2];
        const cfg = load(home, io);
        if (!cfg) return 1;
        if (ev === 'candidates' && (v === 'digest' || v === 'each' || v === 'off')) cfg.telegram.notify.candidates = v;
        else if (['entries', 'closes', 'halts', 'spend', 'daily'].includes(ev ?? '') && (v === 'on' || v === 'off')) (cfg.telegram.notify as unknown as Record<string, boolean>)[ev!] = v === 'on';
        else { io.stderr.write('dexterm telegram: notify candidates digest|each|off, or notify entries|closes|halts|spend|daily on|off\n'); return 2; }
        saveConnectors(home, cfg);
        io.stdout.write(`notify ${ev} ${v}\n`);
        return 0;
      }

      case 'set': {
        const k = argv[1]; const v = argv[2];
        const cfg = load(home, io);
        if (!cfg || !v) { if (cfg) io.stderr.write('dexterm telegram: set summary-at HH:MM|off · set quiet HH:MM-HH:MM|off · set expiry 60..120\n'); return cfg ? 2 : 1; }
        if (k === 'summary-at' && (v === 'off' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v))) cfg.telegram.dailySummaryAt = v === 'off' ? null : v;
        else if (k === 'quiet' && (v === 'off' || /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(v))) cfg.telegram.quietHours = v === 'off' ? null : v;
        else if (k === 'expiry' && Number(v) >= 60 && Number(v) <= 120) cfg.telegram.approvalExpirySec = Math.round(Number(v));
        else { io.stderr.write('dexterm telegram: set summary-at HH:MM|off · set quiet HH:MM-HH:MM|off · set expiry 60..120\n'); return 2; }
        saveConnectors(home, cfg);
        io.stdout.write(`set ${k} ${v}\n`);
        return 0;
      }

      case 'test': {
        const cfg = load(home, io);
        if (!cfg) return 1;
        const store = storeOf(home, cfg, io, deps);
        const token = store.get();
        if (!token || !cfg.telegram.allow.length) { io.stderr.write('dexterm telegram: set up and pair first (dexterm telegram setup)\n'); return 1; }
        const conn = connectorFor(deps, () => token, io);
        const audit = new ChatAudit(home, { knownToken: () => token });
        let bad = 0;
        for (const chatId of [...new Set(cfg.telegram.allow.map((a) => a.chatId))]) {
          try {
            const ref = await conn.send({ chatId }, { kind: 'text', badge: 'PAPER', lines: ['TEST · dexterm can reach this chat.', 'Commands: /status /pause /kill /help. Trades are approved only with buttons.'] });
            audit.add((deps.now ?? Date.now)(), 'out', { template: 'test', chatId, messageId: ref.messageId });
            io.stdout.write(`✓ sent to chat ${chatId}\n`);
          } catch (e) { bad++; io.stderr.write(`✗ chat ${chatId}: ${redact((e as Error).message, token)}\n`); }
        }
        return bad ? 1 : 0;
      }

      case 'audit': {
        const chain = verifyChatAudit(home);
        if (!chain.length) { io.stdout.write('no chat audit yet (autotrade/chat/ under your dexterm home)\n'); return 0; }
        const verify = argv.includes('--verify');
        for (const c of chain) io.stdout.write(verify ? (c.check.ok ? `✓ ${c.day}  ${c.check.events} events  head ${c.check.head}\n` : `✗ ${c.day}  broken at event ${c.check.at}: ${c.check.error}\n`) : `  ${c.day}  ${c.check.events} events\n`);
        const broken = chain.filter((c) => !c.check.ok).length;
        if (verify) io.stdout.write(broken ? `${broken} broken day file${broken === 1 ? '' : 's'}\n` : 'every chat audit chain verifies\n');
        return verify && broken ? 1 : 0;
      }

      case 'revoke': {
        const cfg = load(home, io);
        if (!cfg) return 1;
        storeOf(home, cfg, io, deps).remove();
        cfg.telegram = { ...defaultTelegram(), notify: cfg.telegram.notify, dailySummaryAt: cfg.telegram.dailySummaryAt, quietHours: cfg.telegram.quietHours };
        saveConnectors(home, cfg);
        io.stdout.write('✓ token removed and every paired chat forgotten. Also revoke the token in @BotFather (/revoke) if it may have leaked.\n');
        return 0;
      }

      default:
        io.stderr.write(`dexterm telegram: unknown subcommand ${JSON.stringify(sub)}\n\n${TELEGRAM_USAGE}`);
        return 2;
    }
  } catch (e) {
    io.stderr.write(`dexterm telegram: ${redact((e as Error).message)}\n`);
    return 1;
  }
}
