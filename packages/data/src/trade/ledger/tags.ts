// task-1530 — the agent's PROFILE / REPROFILE / EXIT declarations as STRUCTURED fields.
//
// Before this card the only record of "why this entry, under which exit profile" and "why this exit" was the
// agent's free text, scraped afterwards by whoever read the transcript (a challenge driver read thinking blocks
// that the CLI streams as a paraphrase, so every fill of two sessions came out "undeclared profile / untagged
// exit" although the agent had written both lines). Now the trade tools take the declaration as typed arguments
// and the desk persists it on the fill itself (`agent.paper.fill` data.tag), so nothing is ever recovered from
// text again:
//
//   paper_confirm  profile, reason        (and/or tag_line: the verbatim PROFILE line, parsed here)
//   paper_close    exit_reason, reason    (and/or tag_line: the verbatim EXIT line)
//   paper_tag      a REPROFILE, or a PROFILE / EXIT line that was not passed with its fill (journaled as late)
//
// A typed field always wins over a parsed line; a line that does not parse is kept verbatim (capped) with source
// 'tag-line' only when it yields a profile or reason. Nothing here is an instruction: every string is one line,
// capped, control characters out, key-shaped runs redacted.

import { cleanCode, cleanLedgerText, type FillTag, type TagSource } from './schema.ts';

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const stripMd = (s: string): string => s.replace(/^[\s>*_`#-]+/, '').replace(/[*_`]+/g, '').trim();
const symKey = (s: string): string => s.replace(/^\$/, '').replace(/[.,;:]+$/, '').toUpperCase();

export type ParsedTag =
  | { kind: 'profile'; profile: string; symbol: string; mintHead: string | null; mintTail: string | null; why: string; sizeSol: number | null; line: string }
  | { kind: 'reprofile'; symbol: string; from: string; to: string; why: string; line: string }
  | { kind: 'exit'; symbol: string; reason: string; why: string; line: string };

/**
 * Parse the tagged lines in a block of agent text (the format the exit-profile skills teach):
 *   PROFILE <profile> for <SYMBOL> (<first 4>…<last 4>): <why> · size <x> SOL (<p>% of bankroll)
 *   REPROFILE <SYMBOL> <from> -> <to>: <why>
 *   EXIT <SYMBOL> <reason>: <why>
 */
export function parseTagLines(text: unknown): ParsedTag[] {
  const out: ParsedTag[] = [];
  if (typeof text !== 'string') return out;
  for (const raw of text.slice(0, 4000).split('\n')) {
    const line = stripMd(raw);
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^PROFILE\s+([a-z][a-z0-9-]*)\s+for\s+(\S+?)\s*(?:\(([^)]*)\))?\s*:\s*(.+)$/i))) {
      const hint = (m[3] ?? '').match(new RegExp(`^(${B58}{3,8})\\s*(?:…|\\.\\.\\.)\\s*(${B58}{3,8})$`));
      const size = m[4].match(/size\s+([0-9]*\.?[0-9]+)\s*SOL/i);
      out.push({ kind: 'profile', profile: m[1].toLowerCase(), symbol: symKey(m[2]), mintHead: hint?.[1] ?? null, mintTail: hint?.[2] ?? null, why: m[4].trim(), sizeSol: size ? Number(size[1]) : null, line });
    } else if ((m = line.match(/^REPROFILE\s+(\S+)\s+([a-z][a-z0-9-]*)\s*(?:->|→)\s*([a-z][a-z0-9-]*)\s*:\s*(.+)$/i))) {
      out.push({ kind: 'reprofile', symbol: symKey(m[1]), from: m[2].toLowerCase(), to: m[3].toLowerCase(), why: m[4].trim(), line });
    } else if ((m = line.match(/^EXIT\s+(\S+)\s+([a-z0-9-]+)\s*:\s*(.+)$/i))) {
      out.push({ kind: 'exit', symbol: symKey(m[1]), reason: m[2].toLowerCase(), why: m[3].trim(), line });
    }
  }
  return out;
}

/** The profile / exit-reason alphabet: the strategy id rule (`^[a-z][a-z0-9-]{1,31}$`). Anything else is dropped. */
export function tagCode(x: unknown): string | null {
  const c = cleanCode(x, 32);
  return c && /^[a-z][a-z0-9-]{0,31}$/.test(c) ? c : null;
}

export interface TagInput {
  /** Entry: the exit profile the agent declared (scalp, swing, runner, moonbag, a strategy's own profile id). */
  profile?: unknown;
  /** The agent's own words for this entry or exit (one line, <= 200 chars). */
  reason?: unknown;
  /** Exit: the reason code (tp1, trail, stop, time, thesis-liquidity, thesis-split, agent, …). */
  exitReason?: unknown;
  /** The verbatim PROFILE / EXIT line, when the agent passed one. */
  line?: unknown;
}

/**
 * The structured tag a fill carries, or null when the agent declared nothing. Typed fields win; a `line` fills
 * whatever the typed fields left empty (source 'tag-line' when the line supplied the profile / reason code).
 */
export function buildFillTag(side: 'buy' | 'sell', input: TagInput | null | undefined): FillTag | null {
  if (!input || typeof input !== 'object') return null;
  let profile = side === 'buy' ? tagCode(input.profile) : null;
  let exitReason = side === 'sell' ? tagCode(input.exitReason) : null;
  let reason = cleanLedgerText(input.reason, 200);
  const line = cleanLedgerText(input.line, 300);
  const structured = side === 'buy' ? profile !== null : exitReason !== null;
  let fromLine = false;
  if (line) {
    const tags = parseTagLines(line);
    const p = side === 'buy' ? tags.find((g) => g.kind === 'profile') : tags.find((g) => g.kind === 'exit');
    if (p && p.kind === 'profile') { if (!profile) { profile = tagCode(p.profile); fromLine = profile !== null; } if (!reason) reason = cleanLedgerText(p.why, 200); }
    if (p && p.kind === 'exit') { if (!exitReason) { exitReason = tagCode(p.reason); fromLine = exitReason !== null; } if (!reason) reason = cleanLedgerText(p.why, 200); }
  }
  if (!profile && !exitReason && !reason && !line) return null;
  const source: TagSource = structured ? 'structured' : fromLine ? 'tag-line' : 'missing';
  return { profile, reason, exitReason, line, source };
}

/** A tag call (`paper_tag`) after the fact: what it declares, or why it declares nothing. */
export type LateTag =
  | { ok: true; tagKind: 'profile'; profile: string; reason: string | null; line: string | null }
  | { ok: true; tagKind: 'reprofile'; from: string | null; to: string; reason: string | null; line: string | null }
  | { ok: true; tagKind: 'exit'; exitReason: string; reason: string | null; line: string | null }
  | { ok: false; why: string };

export function buildLateTag(input: { kind?: unknown; profile?: unknown; from?: unknown; to?: unknown; exitReason?: unknown; reason?: unknown; line?: unknown }): LateTag {
  const line = cleanLedgerText(input.line, 300);
  const reason = cleanLedgerText(input.reason, 200);
  const kind = input.kind;
  const parsed = line ? parseTagLines(line)[0] ?? null : null;
  const k = kind === 'profile' || kind === 'reprofile' || kind === 'exit' ? kind : parsed?.kind ?? null;
  if (!k) return { ok: false, why: 'say what this declares: kind profile | reprofile | exit, or a PROFILE / REPROFILE / EXIT line' };
  if (k === 'profile') {
    const profile = tagCode(input.profile) ?? (parsed?.kind === 'profile' ? tagCode(parsed.profile) : null);
    if (!profile) return { ok: false, why: 'a profile tag needs a profile id (or a PROFILE line that names one)' };
    return { ok: true, tagKind: 'profile', profile, reason: reason ?? (parsed?.kind === 'profile' ? cleanLedgerText(parsed.why, 200) : null), line };
  }
  if (k === 'reprofile') {
    const to = tagCode(input.to) ?? (parsed?.kind === 'reprofile' ? tagCode(parsed.to) : null);
    if (!to) return { ok: false, why: 'a reprofile tag needs `to` (or a REPROFILE line)' };
    const from = tagCode(input.from) ?? (parsed?.kind === 'reprofile' ? tagCode(parsed.from) : null);
    return { ok: true, tagKind: 'reprofile', from, to, reason: reason ?? (parsed?.kind === 'reprofile' ? cleanLedgerText(parsed.why, 200) : null), line };
  }
  const exitReason = tagCode(input.exitReason) ?? (parsed?.kind === 'exit' ? tagCode(parsed.reason) : null);
  if (!exitReason) return { ok: false, why: 'an exit tag needs an exit reason code (or an EXIT line)' };
  return { ok: true, tagKind: 'exit', exitReason, reason: reason ?? (parsed?.kind === 'exit' ? cleanLedgerText(parsed.why, 200) : null), line };
}
