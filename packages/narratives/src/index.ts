// @dexterm/narratives (task-1818): MEMES + NARRATIVES tracker. Keyless, local: coin names/tickers/descriptions are
// normalised, embedded (built-in lexical model by default; optional local MiniLM / Ollama), clustered incrementally
// into narratives with stable ids, and measured per window. Measured heat, never advice.
export * from './normalize.ts';
export * from './embed.ts';
export * from './cluster.ts';
export * from './tracker.ts';
export * from './export.ts';
export * from './recorder.ts';
export * from './label.ts';
