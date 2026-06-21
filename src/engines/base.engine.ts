import { inspect } from 'node:util';
import { LoquiError } from '../errors.js';
import type { LoquiConfig, TranslationChunk, TranslationResult } from '../types.js';
import { type RetryOptions, sanitizeForDisplay } from './utils.js';

export abstract class BaseEngine {
  protected config: LoquiConfig;
  #apiKey: string;
  #rateLimitSignal: (() => void) | undefined;
  #fetchFn: RetryOptions['fetchFn'];
  #sleepFn: RetryOptions['sleepFn'];

  constructor(config: LoquiConfig, apiKey: string) {
    this.config = config;
    this.#apiKey = apiKey;
  }

  getApiKey(): string {
    return this.#apiKey;
  }

  /** wired by the AIMD concurrency pool so that 429 events reduce the active window. */
  setRateLimitSignal(fn: () => void): void {
    this.#rateLimitSignal = fn;
  }

  protected getRateLimitSignal(): (() => void) | undefined {
    return this.#rateLimitSignal;
  }

  /**
   * test-only hook — injects fetch/sleep so unit tests avoid real network calls.
   * @internal Not part of the public API; do not call in production code.
   */
  _setFetch(
    fetchFn: NonNullable<RetryOptions['fetchFn']>,
    sleepFn: NonNullable<RetryOptions['sleepFn']> = () => Promise.resolve(),
  ): void {
    this.#fetchFn = fetchFn;
    this.#sleepFn = sleepFn;
  }

  protected retryHooks(): Pick<RetryOptions, 'fetchFn' | 'sleepFn'> {
    return { fetchFn: this.#fetchFn, sleepFn: this.#sleepFn };
  }

  [inspect.custom](): string {
    return `${this.constructor.name} { config: ${inspect(this.config, { depth: null })} }`;
  }

  /** Makes the underlying API call. Implemented by each engine subclass. */
  protected abstract makeCall(
    systemPrompt: string,
    userPrompt: string,
    expectedKeys: string[],
    targetLocales: string[],
  ): Promise<Record<string, TranslationResult>>;

  translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string,
  ): Promise<Record<string, TranslationResult>> {
    return this.makeCall(
      this.buildSystemPrompt(targetLocales, sourceLocale, namespace),
      this.buildUserPrompt(chunk, targetLocales, sourceLocale),
      Object.keys(chunk.keys),
      targetLocales,
    );
  }

  reviewChunk(
    chunk: TranslationChunk,
    initial: Record<string, TranslationResult>,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string,
  ): Promise<Record<string, TranslationResult>> {
    return this.makeCall(
      this.buildSystemPrompt(targetLocales, sourceLocale, namespace),
      this.buildReviewPrompt(chunk, initial, targetLocales, sourceLocale),
      Object.keys(chunk.keys),
      targetLocales,
    );
  }

  protected buildSystemPrompt(targetLocales: string[], sourceLocale: string, namespace: string): string {
    if (this.config.prompts?.system) {
      return interpolateTemplate(this.config.prompts.system, {
        sourceLocale,
        targetLocales: targetLocales.join(', '),
        namespace,
        context: this.config.context ?? '',
        json: '',
      });
    }

    const localeList = targetLocales.join(', ');

    const domainContext = this.config.context
      ? `Working on: ${this.config.context}`
      : 'Professional software localization engine.';

    return [
      domainContext,
      `Translating "${namespace}" from "${sourceLocale}" to: ${localeList}.`,
      'Respond ONLY with valid JSON. Top-level keys must be the locale codes.',
      'Keep placeholders like {{token}} unchanged.',
      'Translate text only. Preserve capitalization style.',
    ].join('\n');
  }

  protected buildUserPrompt(chunk: TranslationChunk, targetLocales: string[], sourceLocale: string): string {
    const json = JSON.stringify(chunk.keys, null, 2);

    if (this.config.prompts?.user) {
      return interpolateTemplate(this.config.prompts.user, {
        sourceLocale,
        targetLocales: targetLocales.join(', '),
        namespace: '',
        context: this.config.context ?? '',
        json,
      });
    }

    return `Translate from "${sourceLocale}" to: ${targetLocales.join(', ')}.\n\n${json}`;
  }

  protected buildReviewPrompt(
    chunk: TranslationChunk,
    initial: Record<string, TranslationResult>,
    targetLocales: string[],
    sourceLocale: string,
  ): string {
    const sourceJson = JSON.stringify(chunk.keys, null, 2);
    const initialJson = JSON.stringify(
      Object.fromEntries(targetLocales.map((l) => [l, initial[l]?.keys ?? {}])),
      null,
      2,
    );
    return [
      `Review and correct these translations from "${sourceLocale}" to: ${targetLocales.join(', ')}.`,
      'Fix errors in meaning, register, or completeness. Preserve placeholder tokens (⟦0⟧, ⟦1⟧…) unchanged.',
      'Return all keys for every locale — unchanged if already correct.',
      '',
      'Source:',
      sourceJson,
      '',
      'Initial translations:',
      initialJson,
    ].join('\n');
  }

  protected parseResponse(
    raw: string,
    expectedKeys: string[],
    targetLocales: string[],
  ): Record<string, TranslationResult> {
    const cleaned = raw
      .replace(/^```(?:json)?\n/i, '')
      .replace(/\n```$/, '')
      .trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new LoquiError('PARSE_ERROR', `Engine returned invalid JSON:\n${sanitizeForDisplay(raw)}`);
    }

    return this.extractTranslations(parsed, expectedKeys, targetLocales);
  }

  protected extractTranslations(
    parsed: Record<string, unknown>,
    expectedKeys: string[],
    targetLocales: string[],
  ): Record<string, TranslationResult> {
    const result: Record<string, TranslationResult> = {};
    for (const locale of targetLocales) {
      const localeData = parsed[locale];
      if (!localeData || typeof localeData !== 'object') {
        process.stderr.write(
          `\x1b[33m[❗️] Engine response missing locale "${locale}" — all ${expectedKeys.length} key(s) will be empty\x1b[0m\n`,
        );
        result[locale] = {
          keys: Object.fromEntries(expectedKeys.map((k) => [k, ''])),
        };
        continue;
      }
      const keys: Record<string, string> = {};
      for (const key of expectedKeys) {
        const val = (localeData as Record<string, unknown>)[key];
        if (typeof val !== 'string') {
          process.stderr.write(
            `\x1b[33m[❗️] Engine response key "${key}" for locale "${locale}" is not a string (got ${typeof val}) — using empty string\x1b[0m\n`,
          );
        }
        keys[key] = typeof val === 'string' ? val : '';
      }
      result[locale] = { keys };
    }

    return result;
  }
}

function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}
