// Engine selection (task-1282). Picks the STT and TTS engines for this machine, honouring explicit
// env overrides and falling back gracefully. The app degrades to text (never crashes) when nothing is
// available; selectStt() returns null in that case and the controller says so.

import type { SttEngine, TtsEngine } from './types.ts';
import { AppleStt } from './stt/apple.ts';
import { WhisperStt } from './stt/whisper.ts';
import { FakeStt } from './stt/fake.ts';
import { SayTts } from './tts/say.ts';
import { FakeTts } from './tts/fake.ts';

export type SttChoice = 'auto' | 'apple' | 'whisper' | 'fake' | 'none';
export type TtsChoice = 'auto' | 'say' | 'fake' | 'none';

/**
 * Resolve the STT engine. `auto` prefers Apple Speech (on-device, streaming), then whisper base.en,
 * then none. An explicit choice is returned even if it later proves unavailable, so the doctor and the
 * status line can report exactly why voice-in is off.
 */
export async function selectStt(choice: SttChoice = (process.env.DEXTERM_VOICE_STT as SttChoice) || 'auto'): Promise<SttEngine | null> {
  if (choice === 'none') return null;
  if (choice === 'fake') return new FakeStt();
  if (choice === 'apple') return new AppleStt();
  if (choice === 'whisper') return new WhisperStt();
  // auto: probe in preference order.
  const apple = new AppleStt();
  if (await apple.available()) return apple;
  const whisper = new WhisperStt();
  if (await whisper.available()) return whisper;
  return null;
}

/** Resolve the TTS engine. `auto` uses macOS `say` when present, else none (voice replies off). */
export async function selectTts(choice: TtsChoice = (process.env.DEXTERM_VOICE_TTS as TtsChoice) || 'auto', defaultVoice?: string): Promise<TtsEngine | null> {
  if (choice === 'none') return null;
  if (choice === 'fake') return new FakeTts();
  if (choice === 'say') return new SayTts(defaultVoice);
  const say = new SayTts(defaultVoice);
  if (await say.available()) return say;
  return null;
}
