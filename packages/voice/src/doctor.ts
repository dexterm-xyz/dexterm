// Voice-mode doctor checks (task-1282 scope item 4). Returns the same check shape the CLI doctor uses
// so `dexterm doctor` can render them inline. Everything the checks depend on (platform, which engines
// resolved, whether swiftc / a whisper model / a mic tool are present) is injected, so the checks are
// deterministic in tests and never spawn or hang. The guiding rule: if a component is missing, say
// exactly what to install, and make clear voice DEGRADES TO TEXT rather than breaking the app.

export type VoiceCheckStatus = 'pass' | 'warn' | 'fail';

export interface VoiceCheck {
  name: string;
  status: VoiceCheckStatus;
  detail: string;
  fix?: string;
}

export interface VoiceDoctorDeps {
  platform: NodeJS.Platform;
  /** macOS `say` present (speech-out). */
  sayAvailable: boolean;
  /** Number of installed `say` voices (0 when say is missing). */
  voiceCount: number;
  /** swiftc present → the Apple Speech helper can be compiled. */
  swiftcPresent: boolean;
  /** whisper-cli present on PATH. */
  whisperBinPresent: boolean;
  /** whisper base.en model present on disk. */
  whisperModelPresent: boolean;
  /** A mic-capture tool (sox/rec or ffmpeg) present — needed by the whisper path. */
  micToolPresent: boolean;
  /** The STT engine that resolved for this machine, or null when voice-in is unavailable. */
  resolvedStt: string | null;
}

/** Produce the voice checks. Never throws. */
export function voiceDoctor(deps: VoiceDoctorDeps): VoiceCheck[] {
  const checks: VoiceCheck[] = [];

  if (deps.platform !== 'darwin') {
    checks.push({
      name: 'Voice mode', status: 'warn',
      detail: `voice mode is macOS-only for now (speech uses the built-in \`say\` and Apple Speech); on ${deps.platform} it stays off and dexterm runs as text`,
      fix: 'Use dexterm on macOS for voice, or just use the keyboard — every voice action has a key.',
    });
    return checks;
  }

  // Speech OUT — macOS say.
  if (deps.sayAvailable) {
    checks.push({ name: 'Voice out (say)', status: 'pass', detail: `macOS \`say\` ready · ${deps.voiceCount} voice${deps.voiceCount === 1 ? '' : 's'} (press the voice key, then cycle the voice)` });
  } else {
    checks.push({
      name: 'Voice out (say)', status: 'warn',
      detail: 'macOS `say` not found; spoken replies are off, the analyst still answers in text',
      fix: '`say` ships with macOS — if it is missing, reinstall the Command Line Tools (`xcode-select --install`).',
    });
  }

  // Speech IN — Apple Speech (preferred) or whisper (fallback).
  if (deps.resolvedStt === 'apple' || deps.swiftcPresent) {
    checks.push({ name: 'Voice in (Apple Speech)', status: 'pass', detail: 'on-device Apple Speech via swiftc (no key, streaming) — the first run asks for Microphone + Speech permission at the Mac' });
  } else if (deps.resolvedStt === 'whisper' || (deps.whisperBinPresent && deps.whisperModelPresent && deps.micToolPresent)) {
    checks.push({ name: 'Voice in (whisper)', status: 'pass', detail: 'whisper.cpp base.en + a mic tool (local, no key)' });
  } else {
    // Nothing for voice-in: steer to the fastest free path and make clear text still works.
    const bits: string[] = [];
    if (!deps.swiftcPresent) bits.push('no swiftc (Apple Speech)');
    if (!deps.whisperBinPresent) bits.push('no whisper-cli');
    else if (!deps.whisperModelPresent) bits.push('no base.en model');
    if (!deps.micToolPresent) bits.push('no mic tool (sox/ffmpeg)');
    checks.push({
      name: 'Voice in', status: 'warn',
      detail: `speech-to-text is off (${bits.join(', ')}); you can still type questions — voice degrades to text`,
      fix: 'Fastest free path: install Xcode command line tools for Apple Speech (`xcode-select --install`). '
        + 'Or whisper: `brew install whisper-cpp sox`, then download base.en to '
        + '`~/.dexterm/models/ggml-base.en.bin` (from the whisper.cpp model repo). Never use large-v3-turbo on a CPU-only Mac — it is unusably slow.',
    });
  }

  // Mic-capture tool note (only relevant to the whisper path; Apple Speech captures its own audio).
  if (!deps.micToolPresent && deps.resolvedStt !== 'apple') {
    checks.push({
      name: 'Mic capture', status: 'warn',
      detail: 'no sox/ffmpeg found; the whisper voice-in path needs one (Apple Speech does not)',
      fix: '`brew install sox` (smallest) or `brew install ffmpeg`.',
    });
  }

  return checks;
}
