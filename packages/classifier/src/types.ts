// Shared types for @dexterm/classifier (task-1822).
//
// A classifier answers TYPED QUESTIONS about ONE DOCUMENT (the coin dossier) with a probability per label. The
// question shapes follow the System One API (`POST /v1/systemone`, TypeSafe's public API, also served by llama.cpp
// for Kev GGUFs): `choice` (one of named options), `noul` (yes/no, probability of yes), `score` (ordered levels).
// Every result names the provider, model id/version and how its probabilities were calibrated, and is labelled a
// model estimate. Nothing here signs, trades, arms anything or raises a cap.

export type QuestionType = 'choice' | 'noul' | 'score';

export interface Question {
  /** Stable id, also the key in the request and the answer map: [a-z][a-z0-9_]{0,39}. */
  id: string;
  type: QuestionType;
  /** The question, first-party text (never token-derived). */
  instructions: string;
  /**
   * choice: label -> description (description may be null). noul: optional {true, false} descriptions.
   * score: ordered level descriptions, lowest first (2..10).
   */
  criteria?: Record<string, string | null> | string[];
}

export interface QuestionSet {
  /** Id of the set, e.g. `coin-risk/1`. Recorded with every result so outputs stay comparable. */
  id: string;
  questions: Question[];
}

/** The document a question set is asked about. `untrusted` text is firewalled before any provider sees it. */
export interface Dossier {
  /** Coin mint (or another stable subject id). */
  subject: string;
  /** First-party numeric / categorical facts (metadata, holder stats, tape summary). */
  facts: Record<string, string | number | boolean | null>;
  /** Token-derived text: symbol, name, bio, social posts. Treated as DATA, never instructions. */
  untrusted?: Partial<Record<'symbol' | 'name' | 'description' | 'text', string | null>>;
  /** Optional link features for the heuristic (the LARP link-shape score). */
  link?: import('@dexterm/data').LinkFeatures;
}

export interface Answer {
  type: QuestionType;
  /** Probability per label (choice: option; noul: `yes`/`no`; score: level index as string). Sums to 1. */
  probs: Record<string, number>;
  /**
   * Log-scores per label. Decision servers return probabilities only, so for remote providers these are
   * ln(p) (logits up to an additive constant; differences are exact). The heuristic returns its own log-odds.
   */
  logits: Record<string, number>;
  /** Most likely label. */
  top: string;
  /** Provider-reported confidence (0 = uniform), or 1 - normalised entropy when the provider gives none. */
  confidence: number;
  /** Probabilities before the local calibration map, when one was applied. */
  raw_probs?: Record<string, number>;
}

export interface Calibration {
  /** `provider` = the model's own temperature only; `platt` = a local logistic map fitted on labelled rows. */
  kind: 'none' | 'provider' | 'platt' | 'points';
  note: string;
}

export interface ClassifyResult {
  /** Always 'model-estimate': these are estimates, never advice. */
  label: 'model-estimate';
  provider: ProviderId;
  model: string;
  model_version: string | null;
  question_set: string;
  subject: string;
  answers: Record<string, Answer>;
  latency_ms: number;
  usage: { input_tokens: number | null; cost_usd: number | null; cost_note: string };
  calibration: Calibration;
  /** The firewall found instruction-like text in the token-derived fields; that text was removed before the call. */
  injection_suspected: boolean;
  /** Set when the configured provider failed and a fallback answered. */
  fallback_from?: { provider: ProviderId; error: string };
}

export type ProviderId = 'heuristic' | 'kev-local' | 'jev-hosted' | 'jev-open' | 'claude' | 'ollama-llm';

export const PROVIDER_IDS: readonly ProviderId[] = ['heuristic', 'kev-local', 'jev-hosted', 'jev-open', 'claude', 'ollama-llm'];

export interface ProviderInfo {
  id: ProviderId;
  /** Short human description for `classifier list`. */
  title: string;
  /** Whether a call can leave the machine (hosted API). */
  network: 'none' | 'local' | 'remote';
  /** Whether it needs a downloaded model / running server. */
  needs: string;
}

/** What every provider implements. One request answers a whole question set about one dossier. */
export interface Provider {
  readonly id: ProviderId;
  /** Model id the next call would use (for status output). */
  model(): string;
  classify(set: QuestionSet, state: PreparedState, opts?: { signal?: AbortSignal }): Promise<ProviderAnswer>;
  /** Cheap readiness check (server up, key present, model downloaded). Never spends money. */
  status(): Promise<{ ready: boolean; detail: string }>;
}

/** A dossier after the firewall: the JSON `state` sent to a model, plus what the heuristic needs. */
export interface PreparedState {
  subject: string;
  state: Record<string, unknown>;
  injection_suspected: boolean;
  dossier: Dossier;
}

export interface ProviderAnswer {
  model: string;
  model_version: string | null;
  answers: Record<string, Answer>;
  input_tokens: number | null;
  cost_usd: number | null;
  cost_note: string;
  calibration: Calibration;
}

export class ClassifierError extends Error {
  readonly code: 'offline' | 'unauthorized' | 'rate_limited' | 'bad_response' | 'not_ready' | 'consent' | 'invalid';
  readonly retryAfterMs: number | null;
  constructor(code: ClassifierError['code'], message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ClassifierError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
