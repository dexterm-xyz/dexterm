// dexterm — the AUTOTRADE screen's key handling (`Q`, task-1508). The loop calls autotradeKey() first while the
// screen captures typed keys (an id / file line, a field value, the flatten confirm), and autotradeAction() for
// every resolved action while the screen is open. Both only change this screen's state and the user's own
// strategy files; nothing here reaches a wallet, a key, a mandate or the signer.

import type { AppAction, Key } from '@dexterm/tui';
import {
  INPUT_MAX, backtestSubject, beginFieldEdit, beginImport, beginNew, commitInput, commitTyping, confirmKey, exportSelected,
  nextView, openEditor, reloadList, refreshRunner, revalidateTyping, runnerVerb, saveEditor, selectedEntry, startBacktest,
  startCompareBacktest, startSweep, toggleMark, undoEditor, type AutotradeUi,
} from './autotrade-ui.ts';
import { openReview, reviewKey } from './autotrade-proposals.ts';

const PRINTABLE = (k: Key): string | null => (k.name === 'space' ? ' ' : k.name === 'char' && k.ch && !k.ctrl && !k.alt && !/[\u0000-\u001f\u007f]/.test(k.ch) ? k.ch : null);

/** A captured key (input line, field value or confirm). Returns true when the key was consumed. */
export function autotradeKey(ui: AutotradeUi, key: Key): boolean {
  // task-1507: a chat proposal's review card owns the keyboard (y applies, a LOOSER edit needs a second y, n dismisses)
  if (ui.review) { ui.notice = reviewKey(ui, key); if (!ui.review) reloadList(ui); return true; }
  if (ui.confirm) { ui.notice = confirmKey(ui, key.name === 'char' && key.ch === 'y' && !key.ctrl && !key.alt); return true; }
  if (ui.input) {
    const inp = ui.input;
    if (key.name === 'esc') { ui.input = null; ui.notice = null; return true; }
    if (key.name === 'enter') { ui.notice = commitInput(ui); return true; }
    if (key.name === 'backspace') { inp.text = inp.text.slice(0, -1); return true; }
    if (key.ctrl && key.ch === 'u') { inp.text = ''; return true; }
    const ch = PRINTABLE(key);
    // an id is lowercase letters, digits and dashes only, so it can never carry a path
    if (ch && (inp.kind === 'import' ? inp.text.length < INPUT_MAX : /^[a-z0-9-]$/.test(ch) && inp.text.length < 32)) inp.text += ch;
    return true;
  }
  const ty = ui.view === 'editor' ? ui.editor?.typing : null;
  if (ty) {
    if (key.name === 'esc') { ui.editor!.typing = null; ui.notice = null; return true; }
    if (key.name === 'enter') { ui.notice = commitTyping(ui); return true; }
    if (key.name === 'backspace') ty.text = ty.text.slice(0, -1);
    else if (key.ctrl && key.ch === 'u') ty.text = '';
    else { const ch = PRINTABLE(key); if (ch && ty.text.length < INPUT_MAX) ty.text += ch; else return true; }
    revalidateTyping(ui);
    return true;
  }
  return false;
}

function move(ui: AutotradeUi, delta: number): void {
  if (ui.view === 'list') ui.selected = Math.max(0, Math.min(ui.entries.length - 1, ui.selected + delta));
  else if (ui.view === 'editor' && ui.editor) ui.editor.selected = Math.max(0, Math.min(ui.editor.fields.length - 1, ui.editor.selected + delta));
  else if (ui.view === 'compare' && ui.compare) ui.compare.scroll = Math.max(0, ui.compare.scroll + delta);
}

const PAGE = 10;

/**
 * One resolved action on the AUTOTRADE screen. Returns true when it was handled here (the loop then does
 * nothing else with it); false lets the loop's own handling run (esc on the list pops the screen stack, `q`
 * quits, the global screen keys still navigate away).
 */
export function autotradeAction(ui: AutotradeUi, action: AppAction): boolean {
  const say = (s: string | null | undefined): true => { ui.notice = s ?? null; return true; };
  const e = selectedEntry(ui);
  switch (action) {
    case 'move.down': move(ui, 1); return true;
    case 'move.up': move(ui, -1); return true;
    case 'move.pagedown': move(ui, PAGE); return true;
    case 'move.pageup': move(ui, -PAGE); return true;
    case 'move.top': move(ui, -1e9); return true;
    case 'move.bottom': move(ui, 1e9); return true;
    case 'back': if (ui.view === 'list') return false; ui.view = 'list'; return say(null);
    case 'autotrade.view': nextView(ui); if (ui.view === 'runner') refreshRunner(ui); return say(null);
    case 'open':
    case 'autotrade.edit':
      if (ui.view === 'editor') return say(beginFieldEdit(ui));
      if (ui.view !== 'list') return action === 'open' ? true : say('e edits from the strategies list');
      return say(e ? openEditor(ui, e.id) : 'no strategy selected');
    case 'autotrade.new': return say(ui.view === 'list' ? beginNew(ui, false) : 'n works on the strategies list (esc)');
    case 'autotrade.dup': return say(ui.view === 'list' ? beginNew(ui, true) : 'd works on the strategies list (esc)');
    case 'autotrade.import': if (ui.view !== 'list') return say('i works on the strategies list (esc)'); beginImport(ui); return say(null);
    case 'autotrade.export': return say(ui.view === 'list' ? exportSelected(ui) : 'x works on the strategies list (esc)');
    case 'autotrade.compare': return say(ui.view === 'list' ? toggleMark(ui) : 'c marks strategies on the list (esc)');
    case 'autotrade.save': return say(ui.view === 'editor' ? saveEditor(ui) : 's saves in the editor');
    case 'autotrade.undo': return say(ui.view === 'editor' ? undoEditor(ui) : 'u undoes in the editor');
    case 'autotrade.backtest': {
      if (ui.view === 'compare') return say(startCompareBacktest(ui));
      if (ui.view === 'editor' && ui.editor) return say(`${startBacktest(ui, ui.editor.id)}${ui.editor.edits.length ? ' (the saved version; s saves your edits first)' : ''}`);
      if (ui.view === 'backtest') { const s = backtestSubject(ui); return say(s ? startBacktest(ui, s.id) : 'no strategy selected'); }
      return say(e ? startBacktest(ui, e.id) : 'no strategy selected');
    }
    case 'autotrade.sweep': {
      const id = ui.view === 'editor' && ui.editor ? ui.editor.id : ui.view === 'backtest' ? backtestSubject(ui)?.id : e?.id;
      return say(id ? startSweep(ui, id) : 'no strategy selected');
    }
    case 'autotrade.proposal': return say(ui.view === 'list' ? openReview(ui) || null : 'o reviews chat proposals on the strategies list (esc)');
    case 'autotrade.run':
      ui.view = 'runner';
      refreshRunner(ui);
      reloadList(ui);
      return say('starting and stopping a paper run ships with the runner (not in this build yet) · this view shows a runner as soon as one writes its status file');
    case 'autotrade.kill': refreshRunner(ui); return say(runnerVerb(ui, 'kill'));
    case 'autotrade.pause': refreshRunner(ui); return say(runnerVerb(ui, 'pause'));
    case 'autotrade.flatten': refreshRunner(ui); return say(runnerVerb(ui, 'flatten'));
    default: return false;
  }
}
