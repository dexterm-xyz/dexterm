// @dexterm/voice — JARVIS voice mode (task-1282). Public surface.
//
// Free and portable by requirement: macOS `say` for speech-out, on-device Apple Speech (compiled with
// swiftc) or local whisper.cpp for speech-in — no paid APIs, no shipped keys. Voice can only ask the
// analyst or trigger its existing safe actions; it can NEVER confirm, sign, or execute a trade.
export * from './types.ts';
export { route, isSafe, type VoiceDecision } from './router.ts';
export { spokenSummary, splitSentences, type SpokenSource } from './summary.ts';
export { VoiceController, type VoiceStatus, type VoiceControllerOpts, type LatencySample } from './controller.ts';
export { selectStt, selectTts, type SttChoice, type TtsChoice } from './engines.ts';
export { voiceDoctor, type VoiceCheck, type VoiceCheckStatus, type VoiceDoctorDeps } from './doctor.ts';
export { SayTts } from './tts/say.ts';
export { FakeTts } from './tts/fake.ts';
export { WhisperStt, WHISPER_MODEL, WHISPER_MODEL_DIR } from './stt/whisper.ts';
export { AppleStt, ensureHelper } from './stt/apple.ts';
export { FakeStt, type FakeSttScript } from './stt/fake.ts';
