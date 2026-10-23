// @dexterm/mcp/engine — the local AI engine (Ollama) behind the same tools and limits as the claude path (task-1543).
// It never builds, signs or sends a transaction: it reads, proposes, and (by the user's profile) requests paper or
// live orders that the engine-independent caps, mandates, kill switch and live gating decide.

export { DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_PORT, OllamaClient, OllamaError, REDIRECT_REFUSED, isLoopbackHost, parseOllamaHost, remoteHostWarning, stripThink, type ChatRequest, type ChatResult, type FetchLike, type OllamaHost, type OllamaMessage, type OllamaTool, type OllamaToolCall, type ShowResult } from './ollama.ts';
export { RESTRICTION_LEVELS, RESTRICTION_RANK, RESTRICTION_HELP, DEFAULT_RESTRICTION, CAPABILITY_LEVEL, NEVER_TOOL, SURFACES, ENGINE_PARITY, isRestriction, atLeast, lowerOf, allows, engineToolAllowlist, requiredLevel, type Restriction, type Capability, type Surface, type ParityRow, type ParityStatus } from './restrictions.ts';
export { AI_CONFIG_SCHEMA, ENGINES, ENGINE_CHOICES, FULL_CONFIRM_PHRASE, DEFAULT_NUM_CTX, MODEL_NAME, aiConfigPath, defaultAiConfig, loadAiConfig, saveAiConfig, effectiveRestriction, ollamaSettings, engineChoiceFor, ollamaConfigured, parseEngineChoice, resolveEngineChoice, type AiConfig, type Engine, type EngineChoice, type EffectiveRestriction, type LoadedAiConfig, type OllamaSettings } from './config.ts';
export { McpStdioClient, toOllamaTools, type McpToolDef, type McpStartOpts } from './mcp-client.ts';
export { runToolLoop, structuredAnswer, DEFAULT_MAX_STEPS, DEFAULT_MAX_REFUSALS, type ToolLoopOpts, type ToolLoopResult } from './loop.ts';
export { probeModel, belowBar, pickModel, BAR, SUGGESTED_MODELS, type ModelProbe, type Bar } from './probe.ts';
export { ollamaReasonRunner } from './reason.ts';
