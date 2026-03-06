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

/** engine/model/prompt settings — stored in .falar.json */
export interface FalarConfig {
  engine: SupportedEngine;
  model: SupportedModel;
  /** default source locale (can be overridden per call) */
  from?: string;
  /** default target locales (can be overridden per call) */
  to?: string[];
  temperature: number;
  topP: number;
  concurrency: number;
  splitToken: number;
  context?: string;
  prompts?: { system?: string; user?: string };
  /**
   * Extra regex patterns (strings) for tokens that must survive translation.
   * Applied before built-ins: {{...}}, ${...}, {var}, ICU blocks, HTML tags.
   */
  placeholderPatterns?: string[];
}

export const CONFIG_DEFAULTS: FalarConfig = {
  engine: 'gemini',
  model: 'gemini-2.5-flash',
  temperature: 0.1,
  topP: 1,
  concurrency: 8,
  splitToken: 4000,
};

export type FlatTranslations = Record<string, string>;

export interface TranslationChunk {
  keys: FlatTranslations;
}

export interface TranslationResult {
  keys: FlatTranslations;
}

export type HashStore = Record<string, string>;

export interface RunStats {
  keysTranslated: number;
  apiRequests: number;
  elapsedMs: number;
  warnings: string[];
}

export interface EngineAdapter {
  translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string
  ): Promise<Record<string, TranslationResult>>;
}
