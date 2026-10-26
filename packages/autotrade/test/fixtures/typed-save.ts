// task-1654 r3: the test seam for "the user typed the phrase". saveLimits/saveCaps have no "confirm everything";
// like the CLI, these plan the save first and confirm exactly the planned raises (as a typed phrase would).
import { planCaps, planLimitsSave, saveCaps, saveLimits, type LimitsDoc, type RealCaps } from '../../src/index.ts';

type SaveOpts = Omit<Parameters<typeof saveLimits>[2], 'confirmed' | 'baseline'>;

export function saveTyped(home: string, doc: LimitsDoc, o: SaveOpts = {}): ReturnType<typeof saveLimits> {
  const p = planLimitsSave(home, doc);
  return saveLimits(home, doc, { ...o, confirmed: p.raised, baseline: p.baseline });
}

export function saveCapsTyped(home: string, caps: RealCaps, o: { now?: number } = {}): ReturnType<typeof saveCaps> {
  const p = planCaps(home, caps);
  return saveCaps(home, caps, { ...o, confirmed: 'error' in p ? [] : p.raised, ...('error' in p ? {} : { baseline: p.baseline }) });
}
