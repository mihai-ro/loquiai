export type SupportedEngine = 'gemini' | 'openai' | 'anthropic';

export type GeminiModel =
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-1.5-flash'
  | 'gemini-1.5-pro'
  | (string & {});

export type OpenAIModel =
  | 'gpt-4o'
  | 'gpt-4o-mini'
  | 'gpt-4-turbo'
  | 'gpt-4'
  | 'gpt-3.5-turbo'
  | (string & {});

export type AnthropicModel =
  | 'claude-opus-4-6'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5-20251001'
  | (string & {});

export type SupportedModel = GeminiModel | OpenAIModel | AnthropicModel;

/** engine/model/prompt settings — stored in .loqui.json */
export interface LoquiConfig {
  /** LLM provider to use for translation. */
  engine: SupportedEngine;
  /** Model name for the selected engine (e.g. 'gemini-2.5-flash', 'gpt-4o'). */
  model: SupportedModel;
  /** Default source locale code (e.g. 'en'). Can be overridden per `translate()` call. */
  from?: string;
  /** Default target locale codes (e.g. ['fr', 'de']). Can be overridden per `translate()` call. */
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
}

/** Default configuration values for new projects. */
export const CONFIG_DEFAULTS: LoquiConfig = {
  engine: 'gemini',
  model: 'gemini-2.5-flash',
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

/** A batch of keys to translate in a single API call. */
export interface TranslationChunk {
  keys: FlatTranslations;
}

/** The translated result for a single locale. */
export interface TranslationResult {
  keys: FlatTranslations;
}

/** A mapping of source keys to their content hashes, used for incremental translation. */
export type HashStore = Record<string, string>;

/** Runtime statistics collected during a translation run. */
export interface RunStats {
  /** Number of keys successfully translated. */
  keysTranslated: number;
  /** Total number of API requests made. */
  apiRequests: number;
  /** Total elapsed time in milliseconds. */
  elapsedMs: number;
  /** Non-fatal warnings emitted during the run. */
  warnings: string[];
}

/** Adapter interface for plugging in custom LLM engines. */
export interface EngineAdapter {
  translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string
  ): Promise<Record<string, TranslationResult>>;
}
