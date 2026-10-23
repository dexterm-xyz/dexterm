// dexterm local engine: the pack REASON stage on Ollama (task-1543).
//
// Same contract as the claude runner in @dexterm/packs (reason.ts): one tool-less call over an assembled dossier,
// structured output forced by the schema, and the reply shaped like `claude -p --output-format json` so the
// packs' grounding / tighten-only / flags-kept checks run unchanged. The model id of the call is the local one.

import type { ReasonRunner } from '@dexterm/packs';
import { stripThink, type OllamaClient } from './ollama.ts';

export function ollamaReasonRunner(client: OllamaClient, model: string, numCtx = 16384): ReasonRunner {
  return async ({ prompt, system, schema, timeoutMs }) => {
    const t0 = Date.now();
    try {
      const r = await client.chat({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        format: schema as Record<string, unknown>,
        options: { num_ctx: numCtx, temperature: 0 },
      }, { timeoutMs });
      let structured: unknown = null;
      try { structured = JSON.parse(stripThink(r.content).trim()); } catch { structured = null; }
      const ok = !!structured && typeof structured === 'object' && !Array.isArray(structured);
      return {
        stdout: JSON.stringify({ type: 'result', is_error: !ok, structured_output: ok ? structured : null, total_cost_usd: 0, duration_api_ms: Date.now() - t0, num_turns: 1, engine: 'ollama', model: r.model ?? model }),
        exitCode: ok ? 0 : 1,
        ...(ok ? {} : { stderr: 'the local model did not return the JSON object' }),
      };
    } catch (e) {
      return { stdout: '', exitCode: 127, stderr: `ollama: ${(e as Error).message}` };
    }
  };
}
