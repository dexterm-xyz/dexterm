// Config -> Provider. The CLI and MCP server call `providerFromConfig`; the LLM runners (Claude CLI, local Ollama)
// are injected by the caller so this package never spawns a model process or opens a socket on its own.

import fs from 'node:fs';
import { fileUsage, readTypesafeKey, type ClassifierConfig } from './config.ts';
import { heuristicProvider } from './providers/heuristic.ts';
import { jevOpenProvider, type JevCalibration, type JevDecisionHead } from './providers/jev-open.ts';
import { llmProvider, type LlmRunner } from './providers/llm.ts';
import type { FetchLike } from './providers/http.ts';
import { jevHostedProvider, kevLocalProvider } from './providers/systemone-http.ts';
import { ClassifierError, type Provider, type ProviderId, type ProviderInfo } from './types.ts';

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'heuristic', title: 'Built-in scores (H1 p(rug) + LARP link score)', network: 'none', needs: 'nothing' },
  { id: 'kev-local', title: 'Kev decision model via llama.cpp (open, Apache-2.0)', network: 'local', needs: 'a downloaded Kev GGUF + llama-server' },
  { id: 'jev-hosted', title: "TypeSafe's hosted Jev (flagship, your own API key)", network: 'remote', needs: 'your TypeSafe API key' },
  { id: 'jev-open', title: 'JEV open students (autotrust/JEV-*) via vLLM', network: 'local', needs: 'a vLLM server with the JEV decision adapter (>= 24 GB GPU)' },
  { id: 'claude', title: 'Claude zero-shot (comparison baseline)', network: 'remote', needs: 'the Claude CLI, signed in' },
  { id: 'ollama-llm', title: 'Ollama chat model zero-shot (comparison baseline)', network: 'local', needs: 'Ollama with a chat model' },
];

export interface RegistryDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  claudeRunner?: LlmRunner;
  ollamaRunner?: LlmRunner;
}

export function providerFromConfig(c: ClassifierConfig, id: ProviderId = c.provider, d: RegistryDeps = {}): Provider {
  switch (id) {
    case 'heuristic': return heuristicProvider();
    case 'kev-local': return kevLocalProvider({ endpoint: c.kev.endpoint, modelId: c.kev.model, fetch: d.fetch });
    case 'jev-hosted': return jevHostedProvider({
      endpoint: c.jev.endpoint, model: c.jev.model, apiKey: () => readTypesafeKey(d.env), pricePerMTokUsd: c.jev.pricePerMTokUsd,
      maxCallsPerDay: c.jev.maxCallsPerDay, usage: fileUsage(d.env), fetch: d.fetch,
    });
    case 'jev-open': {
      if (!c.jevOpen.headPath || !c.jevOpen.calibrationPath) throw new ClassifierError('not_ready', 'jev-open needs jevOpen.headPath (adapter_vllm/decision_head.json) and jevOpen.calibrationPath (calibration.json) from the model repo');
      const head = JSON.parse(fs.readFileSync(c.jevOpen.headPath, 'utf8')) as JevDecisionHead;
      const calibration = JSON.parse(fs.readFileSync(c.jevOpen.calibrationPath, 'utf8')) as JevCalibration;
      return jevOpenProvider({ endpoint: c.jevOpen.endpoint, modelId: c.jevOpen.model, head, calibration, fetch: d.fetch });
    }
    case 'claude':
      if (!d.claudeRunner) throw new ClassifierError('not_ready', 'claude baseline: no Claude runner wired');
      return llmProvider({ id: 'claude', model: c.llm.claudeModel, run: d.claudeRunner });
    case 'ollama-llm':
      if (!d.ollamaRunner || !c.llm.ollamaModel) throw new ClassifierError('not_ready', 'ollama-llm baseline: set llm.ollamaModel and have Ollama running');
      return llmProvider({ id: 'ollama-llm', model: c.llm.ollamaModel, run: d.ollamaRunner });
  }
}
