// @dexterm/classifier (task-1822): pluggable classification models. See README in research/classifier-2026-10 and
// the site page "Classification models". Outputs are model estimates with the model id and a calibration note.

export * from './types.ts';
export * from './questions.ts';
export * from './dossier.ts';
export * from './systemone.ts';
export * from './calibrate.ts';
export * from './classify.ts';
export * from './models.ts';
export * from './config.ts';
export * from './hardware.ts';
export * from './registry.ts';
export { heuristicProvider, LARP_POINTS_PLATT, WIN_BASE_RATE } from './providers/heuristic.ts';
export { kevLocalProvider, jevHostedProvider, memoryUsage, JEV_DEFAULT_ENDPOINT, type UsageStore, type KevLocalOpts, type JevHostedOpts } from './providers/systemone-http.ts';
export { jevOpenProvider, jevPrompt, type JevDecisionHead, type JevCalibration } from './providers/jev-open.ts';
export { llmProvider, llmPrompt, llmSchema, extractJson, fromReasonRunner, LLM_SYSTEM, type LlmRunner, type LlmRunResult, type ReasonRunnerLike } from './providers/llm.ts';
export { httpJson, type FetchLike } from './providers/http.ts';
export { coinInputFromSnapshot, dossierFromSnapshot } from './snapshot.ts';
