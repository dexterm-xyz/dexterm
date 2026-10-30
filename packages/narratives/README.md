# @dexterm/narratives (task-1818, EXPERIMENTAL)

The memes + narratives tracker. A memecoin needs no real project to run; it moves on a theme (a ticker pun, an animal,
a celebrity, an AI-agent craze, a season, a copy of a runner). This package groups coins by that theme and measures
each theme's heat. Keyless and local; no network, no model call. **Measured heat, never advice.**

- `normalize.ts`: firewalled name/ticker/description → weighted words (leet, repeats, camelCase, emoji, copy-cat
  affixes, glued tickers), the core meme word, blocking keys, lexicon themes (`@dexterm/packs` lexicon).
- `embed.ts`: `LexicalEmbedder` (default, built in), `MiniLmEmbedder` (all-MiniLM-L6-v2 through transformers.js from
  `DEXTERM_EMBED_MODULE_DIR`, not a dependency), `OllamaEmbedder` (loopback only). `DEXTERM_NARRATIVE_EMBEDDER`.
- `cluster.ts`: incremental leader clustering in first-seen order, stable `nar_…` ids, n-gram labels.
- `tracker.ts`: per-window metrics (5m/1h/6h/24h), lifecycle (`LIFECYCLE_RULES`), copy-cat saturation, traction
  score, rank, transitions.
- `recorder.ts`: time-ordered replay of the recorder DB (`replayRecorder`, `trackerFromRecorder`,
  `RecorderNarratives` = cached + incremental, yields to the event loop).
- `export.ts`: `dexterm-narratives/1` JSON, text table, the coin field, the dashboard status card.
- `label.ts`: optional cached model labels from a caller-supplied local model (never used for metrics).

Surfaces: the N screen (`n` heat table, `enter` drill-down), the token screen's Narrative row, MCP `narratives_top` /
`narrative_detail` / `narrative_of`, rules `narrative_rank` / `narrative_score` / `narrative:<lifecycle>`,
`dexterm narratives`. Tests: `node --test packages/narratives/test/*.test.ts`; live smoke:
`node packages/narratives/scripts/smoke-live.ts` (read-only on the recorder DB). Replay study:
`dexterm/research/narratives-2026-10/` (workspace).
