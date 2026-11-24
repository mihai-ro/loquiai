import type { LogFn } from './utils/logger.js';

export type SupportedEngine = 'gemini' | 'openai' | 'anthropic';

export type GeminiModel =
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-1.5-flash'
  | 'gemini-1.5-pro'
  | (string & {});

export type OpenAIModel = 'gpt-4o' | 'gpt-4o-mini' | 'gpt-4-turbo' | 'gpt-4' | 'gpt-3.5-turbo' | (string & {});

export type AnthropicModel = 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001' | (string & {});

export type SupportedModel = GeminiModel | OpenAIModel | AnthropicModel;

/** engine/model/prompt settings — stored in .loqui.json */
export interface LoquiConfig {
  /** LLM provider to use for translation. */
  engine: SupportedEngine;
  /** Model name for the selected engine (e.g. 'gemini-2.5-flash', 'gpt-4o'). */
  model?: SupportedModel;
  /** Default source locale code (e.g. 'en'). Can be overridden per `translate()` call. */
  from?: string;
  /** Default target locale codes (e.g. ['es', 'de']). Can be overridden per `translate()` call. */
  to?: string[];
  /** LLM sampling temperature. Lower values = more deterministic. Range: 0–2. Default: 0.1. */
  temperature: number;
  /** Nucleus sampling probability. Range: 0–1. Default: 1. */
  topP: number;
  /** Maximum number of concurrent API requests. Range: 1–32. Default: 8. */
  concurrency: number;
  /**
   * Approximate token budget per chunk sent to the LLM.
   * Lower values = more, smaller requests. Range: 500–32000. Default: 4000.
   */
  splitToken: number;
  /** Free-text description of the project domain, injected into system prompts for better translation quality. */
  context?: string;
  /** Override the default system and/or user prompt templates. Use `{{sourceLocale}}`, `{{targetLocales}}`, `{{namespace}}`, `{{context}}`, `{{json}}` as variables. */
  prompts?: { system?: string; user?: string };
  /**
   * Extra regex patterns (as strings) for tokens that must survive translation unchanged.
   * Applied before built-in patterns (mustache, template literals, ICU, HTML tags).
   * @example ['%\\{[^}]+\\}']  // Ruby-style %{variable}
   */
  placeholderPatterns?: string[];
  /** Request timeout in milliseconds. Defaults to 120000 (2 minutes). */
  timeout?: number;
  /** Terminology glossary: lock specific term translations and mark do-not-translate strings. */
  glossary?: GlossaryConfig;
  /** When true, runs a second LLM pass to review and correct each chunk before saving. Doubles API calls. Default: false. */
  review?: boolean;
}

/** Default configuration values for new projects. */
export const CONFIG_DEFAULTS: LoquiConfig = {
  engine: 'gemini',
  temperature: 0.1,
  topP: 1,
  concurrency: 8,
  splitToken: 4000,
};

/** Default model per engine. */
export const DEFAULT_MODELS: Record<SupportedEngine, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
};

/** A flat mapping of dot-notation keys to their string values. */
export type FlatTranslations = Record<string, string>;

/**
 * A JSON document split by leaf type so a round trip loses nothing.
 * Only `strings` is translatable; everything else is carried verbatim.
 */
export interface FlatDocument {
  /** translatable string leaves, dot-keyed. Array elements are keyed positionally. */
  strings: FlatTranslations;
  /** non-string leaves — numbers, booleans, null — plus empty arrays and objects. */
  values: Record<string, unknown>;
  /** paths that held a non-empty array, so unflatten rebuilds `[]` not `{"0":…}`. */
  arrayPaths: string[];
}

/** A batch of keys to translate in a single API call. */
export interface TranslationChunk {
  keys: FlatTranslations;
}

/** The translated result for a single locale. */
export interface TranslationResult {
  keys: FlatTranslations;
}

/** Source hash by key, for one locale. */
export type HashStore = Record<string, string>;
/** The hash sidecar: one `HashStore` per target locale, since each locale is delivered on its own. */
export type LocaleHashes = Record<string, HashStore>;
export type TranslationMemory = Record<string, Record<string, string>>;

/** Terminology glossary configuration. All fields optional; absence disables the feature. */
export interface GlossaryConfig {
  /** File OR folder. Folder = per-locale term files `{path}/{locale}.json` ({ term: target }).
   *  File = combined `{ term: { locale: target } }`. Unset = fall back to an inline `glossary`
   *  key in the source file. */
  path?: string;
  /** Strings emitted verbatim in every locale (brand/product names). */
  noTranslate?: string[];
}

/** Normalized in-memory glossary used during a run. */
export interface GlossaryModel {
  /** term -> { locale -> locked target translation } */
  terms: Record<string, Record<string, string>>;
  noTranslate: string[];
}

/**
 * What a warning is about, so a caller can act on it without matching message text. A minor
 * release may add codes, so an exhaustive `switch` needs a `default` case.
 */
export type RunWarningCode =
  | 'PLACEHOLDER_MISMATCH'
  | 'MISSING_GLOSSARY_TERM'
  | 'EMPTY_TRANSLATION'
  | 'UNTRANSLATED'
  | 'LENGTH_RATIO'
  | 'NOT_SENT'
  | 'RETRY_CAP'
  | 'CHUNK_FAILED'
  | 'CUT_OFF'
  | 'REMOVED_KEYS'
  | 'ENGINE_RESPONSE';

/** A non-fatal problem a run hit, with the locale and key it concerns when it has them. */
export interface RunWarning {
  code: RunWarningCode;
  message: string;
  locale?: string;
  key?: string;
}

/**
 * A run's log: a plain `LogFn` for what an engine says, and `warning()` for what the run
 * itself found. Both record into `stats.warnings` and reach the caller's logger.
 */
export interface RunLog extends LogFn {
  warning(warning: RunWarning): void;
}

/** What a run sends: the first-pass requests, and how many keys each locale is sent. */
export interface RunPlanSummary {
  /**
   * Requests for the planned chunks. A review pass (`config.review`) and a response that is
   * cut off and re-sent in halves add more, and neither is known before an engine answers.
   */
  requests: number;
  /** locale → keys sent for it, after translation memory and the retry cap took theirs out. */
  keys: Record<string, number>;
}

/** Runtime statistics collected during a translation run. */
export interface RunStats {
  /** Number of keys successfully translated. */
  keysTranslated: number;
  /** Total number of API requests made. */
  apiRequests: number;
  /** Total elapsed time in milliseconds. */
  elapsedMs: number;
  /** Non-fatal warnings emitted during the run. */
  warnings: RunWarning[];
  /** Chunks that failed after all retries. Their keys are absent from the output. */
  failedChunks: number;
  /** What the run planned to send. A dry run sends nothing, so this is all it reports. */
  plan: RunPlanSummary;
}

/** A parsed JSON document. */
export type JsonObject = Record<string, unknown>;

/** What a translation run produced, whether it came from memory or from files. */
export interface TranslationRun {
  /** One full document per target locale, keys sorted. */
  locales: Record<string, JsonObject>;
  stats: RunStats;
  /** Keys pruned from each locale's existing document because the source no longer has them. */
  removed: Record<string, string[]>;
}

/** The result of `translateObject()`: the run, plus the state a caller persists to make the next one incremental. */
export interface ObjectRun extends TranslationRun {
  hashes: LocaleHashes;
  memory: TranslationMemory;
  /**
   * Per locale, the keys whose answer this run turned down. The locale still owes them, and a
   * caller can count them to cap retries: pass the ones to stop sending back as `capped`.
   */
  rejected: Record<string, string[]>;
}

/** The result of `translate()`: the run, plus where it was written. */
export interface TranslateResult extends TranslationRun {
  /** locale → path of each file written. Empty on a dry run or when no output was given. */
  written: Record<string, string>;
}

/** What an engine is asked to translate in one call, and where to report while doing it. */
export interface TranslateChunkRequest {
  chunk: TranslationChunk;
  targetLocales: string[];
  sourceLocale: string;
  namespace: string;
  glossaryBlock?: string;
  /**
   * The calling run's log. Per call, not per engine, so two runs sharing one engine
   * instance each get only their own messages in `stats.warnings`.
   */
  log: LogFn;
  /** Call when the provider answers 429. It narrows the calling run's concurrency and no one else's. */
  onRateLimited: () => void;
}

/** A `TranslateChunkRequest` for the self-review pass, with the translations to review. */
export interface ReviewChunkRequest extends TranslateChunkRequest {
  initial: Record<string, TranslationResult>;
}

/** Adapter interface for plugging in custom LLM engines. */
export interface EngineAdapter {
  translateChunk(req: TranslateChunkRequest): Promise<Record<string, TranslationResult>>;
  /** Optional self-review pass — called after translateChunk when config.review is true. */
  reviewChunk?(req: ReviewChunkRequest): Promise<Record<string, TranslationResult>>;
}
