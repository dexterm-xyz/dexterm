// Piper neural TTS engine (task-1408). Piper is a free, local, no-key neural text-to-speech engine
// (rhasspy/piper, MIT) that sounds markedly better than espeak-ng. Off macOS it is the PREFERRED
// speech-out engine; espeak-ng stays the last-resort baseline (see engines.ts). Verified in Docker
// (task-1397/task-1408): the prebuilt Linux binary + the en_GB-alan-medium voice write a valid,
// non-silent 22.05 kHz WAV that whisper.cpp transcribes almost word-for-word.
//
// It carries the SAME contract as the macOS `say` and espeak engines:
//   - text is SANITISED (sanitizeSpeech strips `[[…]]`, control chars, a leading `-`, caps length)
//   - text is delivered on STDIN, never as an argv word
//   - a new speak() cleanly INTERRUPTS the current one — one queue, never two voices at once
//   - the voice is fixed by the downloaded MODEL, never by a macOS voice name (so config.voice.name,
//     which on a Mac is e.g. "Eddy (English (UK))", is NEVER passed verbatim to Piper)
//
// Piper has no audio output of its own: it synthesises to a WAV, which we then play through the
// platform player (aplay / paplay / ffplay — detected and reported by the doctor). Containers have no
// audio device, so real playback is unverified; synthesis-to-file IS verified (synthToFile + whisper).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeakHandle, SpeakOptions, TtsEngine } from '../types.ts';
import { sanitizeSpeech } from './voices.ts';

/** The Piper voice dexterm defaults to off macOS: a British male, medium quality (local, no key). */
export const DEFAULT_PIPER_VOICE = 'en_GB-alan-medium';

/** Where the downloaded Piper voice model lives (see `dexterm voice download piper-voice`). */
export const PIPER_MODEL = process.env.DEXTERM_PIPER_MODEL
  || join(homedir(), '.dexterm', 'models', `${DEFAULT_PIPER_VOICE}.onnx`);

/** Audio players we can hand a WAV to, best-first. Reported by the doctor so the user knows which plays. */
export const PIPER_PLAYERS: readonly string[] = ['aplay', 'paplay', 'ffplay'];

function which(bin: string): string | null {
  if (!bin) return null;
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin) ? bin : null;
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const p of (process.env.PATH ?? '').split(sep)) {
    if (!p) continue;
    if (existsSync(join(p, bin))) return join(p, bin);
    if (process.platform === 'win32' && existsSync(join(p, `${bin}.exe`))) return join(p, `${bin}.exe`);
  }
  return null;
}

/**
 * Resolve the Piper binary. We look at an explicit override, then the dexterm-local install
 * (`~/.dexterm/piper/piper`, where the prebuilt release is extracted), then PATH. NOTE: Debian's
 * `apt install piper` is an UNRELATED gaming-mouse tool, so the doctor steers users to the rhasspy
 * prebuilt release rather than apt; a wrong `piper` on PATH simply fails to synth and voice degrades
 * to text (it never crashes).
 */
export function resolvePiperBin(): string | null {
  return which(process.env.DEXTERM_PIPER_BIN || '')
    || which(join(homedir(), '.dexterm', 'piper', 'piper'))
    || which('piper');
}

/** The player that will play Piper's WAV, or null when none is installed. */
export function pickPlayer(): string | null {
  const override = process.env.DEXTERM_AUDIO_PLAYER;
  if (override) return which(override) ? override : null;
  for (const p of PIPER_PLAYERS) if (which(p)) return p;
  return null;
}

/** Argv to play a finished WAV through the given player (quiet, exits on end, no window). */
function playerArgs(player: string, wav: string): string[] {
  switch (player) {
    case 'ffplay': return ['-nodisp', '-autoexit', '-loglevel', 'quiet', wav];
    case 'paplay': return [wav];
    case 'aplay': default: return ['-q', wav];
  }
}

export class PiperTts implements TtsEngine {
  readonly name = 'piper';
  readonly label = 'Piper (neural, local, no key)';
  private model: string;

  /** The utterance currently playing. A new speak() stops it first, so there is only ever one. */
  private current: SpeakHandle | null = null;

  constructor(model: string = PIPER_MODEL) { this.model = model; }

  /** The voice id this engine speaks with (the model basename), for the status line. */
  get voiceName(): string { return DEFAULT_PIPER_VOICE; }

  /** True when Piper can speak ALOUD here: the binary, the voice model and a player are all present. */
  async available(): Promise<boolean> {
    return resolvePiperBin() !== null && existsSync(this.model) && pickPlayer() !== null;
  }

  /** True when Piper can SYNTHESISE here (binary + model) even with no audio device (used for the proof). */
  canSynth(): boolean {
    return resolvePiperBin() !== null && existsSync(this.model);
  }

  /** Piper's voice is the model; there is no per-machine installed-voice list to cycle. */
  async listVoices(): Promise<string[]> { return [DEFAULT_PIPER_VOICE]; }

  /**
   * Synthesise `text` to a WAV at `outPath`. Resolves on success, rejects on a missing binary/model or a
   * non-zero exit. This is the engine's testable, audio-device-free core — the Docker proof and the unit
   * tests drive it directly. The text is sanitised and delivered on stdin, exactly as speak() does.
   */
  synthToFile(text: string, outPath: string, opts: { lengthScale?: number } = {}): Promise<void> {
    const bin = resolvePiperBin();
    const safe = sanitizeSpeech(text);
    return new Promise((resolve, reject) => {
      if (!bin) { reject(new Error('piper binary not found')); return; }
      const args = ['--model', this.model, '--output_file', outPath];
      if (typeof opts.lengthScale === 'number' && Number.isFinite(opts.lengthScale)) {
        args.push('--length_scale', String(opts.lengthScale)); // >1 = slower speech
      }
      let child: ChildProcess;
      try { child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] }); }
      catch (e) { reject(e as Error); return; }
      let err = '';
      child.stderr?.on('data', (d) => { err += d; });
      child.stdin?.on('error', () => { /* EPIPE if the child died — handled by close/error */ });
      // Piper reads one line of text from stdin; the sanitiser already collapsed newlines to one line.
      try { child.stdin?.end(safe + '\n'); } catch { /* child gone */ }
      child.on('error', reject);
      child.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error(`piper exit ${code}: ${err.slice(-200)}`)));
    });
  }

  speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
    this.stopCurrent(); // single queue: never two speakers at once

    const player = pickPlayer();
    // rate: map the words-per-minute feel to Piper's length_scale (lower rate → slower → larger scale).
    const lengthScale = typeof opts.rate === 'number' && opts.rate > 0 ? Math.max(0.5, Math.min(2, 190 / opts.rate)) : undefined;

    let child: ChildProcess | null = null;
    let stopped = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const dir = mkdtempSync(join(tmpdir(), 'dexterm-piper-'));
    const wav = join(dir, 'speech.wav');
    const cleanup = (): void => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    const finish = (): void => {
      if (stopped) return;
      stopped = true;
      if (this.current === handle) this.current = null;
      cleanup();
      resolve();
    };

    const handle: SpeakHandle = {
      done,
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (this.current === handle) this.current = null;
        try { child?.kill('SIGTERM'); } catch { /* already gone */ }
        cleanup();
        resolve();
      },
    };
    this.current = handle;

    if (!player) { queueMicrotask(finish); return handle; } // no player → can't speak aloud; degrade to text

    // Synthesise, then play. Piper's RTF is ~0.16, so synth is fast; first audio is the player spawn.
    this.synthToFile(text, wav, lengthScale !== undefined ? { lengthScale } : {}).then(() => {
      if (stopped) return;
      try {
        child = spawn(player, playerArgs(player, wav), { stdio: 'ignore' });
        child.on('spawn', () => { if (!stopped) opts.onFirstAudio?.(); });
        child.on('error', finish);
        child.on('close', finish);
      } catch { finish(); }
    }).catch(finish); // synth failed (bad binary/model) → degrade to text

    return handle;
  }

  private stopCurrent(): void {
    const h = this.current;
    if (h) { this.current = null; try { h.stop(); } catch { /* ignore */ } }
  }
}
