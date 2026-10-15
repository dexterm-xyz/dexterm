# @dexterm/voice — JARVIS voice mode (task-1282)

Free and portable by requirement: no paid speech APIs, no shipped keys. Everything here either ships
with macOS or runs locally with no key. If a component is missing, `dexterm doctor` says exactly what
to install and voice **degrades to text** — it never crashes.

## Pieces

- `router.ts` — deterministic, LLM-free intent router. The safety contract: voice can ONLY ask the
  analyst or trigger the analyst's safe actions (navigate, open a token, set a filter, add to the
  watchlist, or OPEN a PAPER ticket in its editing phase). It can **never** confirm, sign, or execute
  a trade. `isSafe()` + its test assert this for every utterance.
- `stt/` — speech-in engines: `apple` (on-device `SFSpeechRecognizer` via a Swift helper compiled with
  `swiftc`, no key, streaming), `whisper` (whisper.cpp `base.en`, local, no key — never
  `large-v3-turbo` on a CPU-only Mac: ~55–93 s/clip), and `fake` (scripted, for headless tests).
- `tts/` — speech-out engines: `say` (built-in macOS `say`, no key, interruptible, voice picker) and
  `fake`.
- `summary.ts` — the first ~2 sentences of an analyst answer, for the spoken reply.
- `controller.ts` — the push-to-talk state machine (toggle; terminals have no key-up). The mic is live
  ONLY in the `listening` mode — the single place `listen()` is called — so the on-screen indicator can
  never disagree with the real mic. Interruptible speech, mute, voice picker, and key-release →
  first-spoken-word latency capture.
- `doctor.ts` — the voice checks `dexterm doctor` renders (warn-only; never fails the doctor).

## In the app

- `v` — push-to-talk (press to talk, press to send; auto-enables voice on first use).
- `m` — mute · `,` — change voice · `esc` — stop speaking / cancel listening.
- A red `● LISTENING` badge on the band under the header whenever the mic is live.

## Latency

`node packages/voice/tools/voice-bench.mjs [--real-claude] [--recompile]` measures the key-release → first-word
budget. Router and `say` are measured live; STT numbers come from the spike (no headless mic). See the
task-1282 handoff for a full table.

## Privacy

Nothing is recorded to disk unless `DEXTERM_VOICE_RECORD=1`. The whisper path writes a transient WAV to
the OS temp dir and deletes it immediately after transcription; Apple Speech keeps no file. Transcribed
text is treated as untrusted user input, like any typed text.
