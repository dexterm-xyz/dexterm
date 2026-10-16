// dexterm — turn a rule-engine alert / proposal into a firewalled AlertDelivery (task-1398). Pure.
//
// Untrusted text (a token symbol, and whatever the user put in the rule's alert text) is run through the
// prompt firewall (control/bidi/ANSI stripped, URLs → [url], foreign base58 → [addr], wide glyphs → ▯,
// injection-like content neutralised) and the spoken form through the `say` sanitiser (defuses `[[…]]`,
// shortens addresses). Nothing reaches a channel raw.
import { firewallText } from '@dexterm/data';
import { sanitizeSpeech } from '@dexterm/voice';
import type { RuleAlert, RuleProposal } from '@dexterm/custom';
import type { AlertDelivery } from './types.ts';

const TITLE_MAX = 64;
const BODY_MAX = 180;

/** Firewall a string; keep the row's own mint readable, drop URLs, cap length. */
function fw(s: string, max: number, mint?: string | null): string {
  return firewallText(s, { keepMint: mint ?? null, keepUrls: false, max }).text;
}

export function alertToDelivery(a: RuleAlert): AlertDelivery {
  const symbol = fw(a.symbol, 24) || '?';
  const body = fw(a.text, BODY_MAX, a.mint);
  const title = `${symbol} ⚑`.slice(0, TITLE_MAX);
  return {
    kind: 'alert', level: a.level, title, body,
    spoken: sanitizeSpeech(`${symbol}. ${body}`),
    symbol, mint: a.mint, source: a.source, rule: a.rule, at: a.at,
  };
}

export function proposalToDelivery(p: RuleProposal): AlertDelivery {
  const symbol = fw(p.symbol, 24) || '?';
  const what = p.type === 'ticket'
    ? `rule proposes ${p.side} ${p.size} ${p.unit} — confirm in the app (nothing armed)`
    : `rule asks the analyst: ${p.skill}`;
  const body = fw(what, BODY_MAX, p.mint);
  const title = `${symbol} ⚑ proposal`.slice(0, TITLE_MAX);
  return {
    kind: 'proposal', level: 'info', title, body,
    spoken: sanitizeSpeech(`${symbol}. ${body}`),
    symbol, mint: p.mint, source: p.source, rule: p.rule, at: p.at,
  };
}

/** The one-line form a text channel sends (Telegram / Discord / stdout toast). */
export function deliveryLine(d: AlertDelivery): string {
  return d.title === `${d.symbol} ⚑` ? `${d.title} ${d.body}` : `${d.title} — ${d.body}`;
}
