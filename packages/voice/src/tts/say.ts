// macOS `say` TTS engine (task-1282). `say` ships with macOS, needs no key and no network, so it is
// the free/portable default (SPEC: macOS say first). It streams to the audio device as it synthesises,
// so time-to-first-audio is close to process spawn. speak() is interruptible via stop() (SIGTERM to
// the child), which is how a key or the user starting to talk cuts a reply short.

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import type { SpeakHandle, SpeakOptions, TtsEngine } from '../types.ts';

export const SAY_BIN = process.env.DEXTERM_SAY_BIN || 'say';

export class SayTts implements TtsEngine {
  readonly name = 'say';
  readonly label = 'macOS say (built-in, no key)';
  private defaultVoice: string | undefined;

  constructor(defaultVoice?: string) { this.defaultVoice = defaultVoice; }

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    return new Promise((resolve) => {
      try {
        const child = execFile(SAY_BIN, ['-v', '?'], { timeout: 4000 }, (err) => resolve(!err || (err as NodeJS.ErrnoException).code !== 'ENOENT'));
        child.on('error', () => resolve(false));
      } catch { resolve(false); }
    });
  }

  /** Parse `say -v '?'`: each line is "Name            en_US    # sample text". */
  async listVoices(): Promise<string[]> {
    return new Promise((resolve) => {
      try {
        execFile(SAY_BIN, ['-v', '?'], { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
          if (err || !stdout) { resolve([]); return; }
          const names: string[] = [];
          for (const line of stdout.split('\n')) {
            const m = line.match(/^(.+?)\s{2,}[a-z]{2}(?:[_-][A-Za-z]+)?\s/);
            if (m) names.push(m[1].trim());
          }
          resolve(names);
        });
      } catch { resolve([]); }
    });
  }

  speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
    const voice = opts.voice ?? this.defaultVoice;
    const rate = opts.rate ?? 190;
    const args: string[] = [];
    if (voice) args.push('-v', voice);
    args.push('-r', String(rate), text);
    let child: ChildProcess | null = null;
    let stopped = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    try {
      child = spawn(SAY_BIN, args, { stdio: 'ignore' });
      // `say` has no first-sample hook; the spawn event is the closest honest lower bound and is what
      // the latency table reports as "first spoken word" for this engine.
      child.on('spawn', () => { if (!stopped) opts.onFirstAudio?.(); });
      child.on('error', () => { if (!stopped) { stopped = true; resolve(); } });
      child.on('close', () => { if (!stopped) { stopped = true; resolve(); } });
    } catch {
      // No `say` on this machine: resolve immediately so the caller degrades to text.
      queueMicrotask(() => { if (!stopped) { stopped = true; resolve(); } });
    }
    return {
      done,
      stop: () => {
        if (stopped) return;
        stopped = true;
        try { child?.kill('SIGTERM'); } catch { /* already gone */ }
        resolve();
      },
    };
  }
}
