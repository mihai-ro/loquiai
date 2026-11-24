import { inspect } from 'node:util';
import { LoquiError } from '../errors.js';
import type {
  LoquiConfig,
  ReviewChunkRequest,
  TranslateChunkRequest,
  TranslationChunk,
  TranslationResult,
} from '../types.js';
import { type RetryOptions, sanitizeForDisplay } from './utils.js';

/** The part of a request a transport needs: where to report, and whom to tell about a 429. */
export type CallContext = Pick<TranslateChunkRequest, 'log' | 'onRateLimited'>;

export abstract class BaseEngine {
  protected config: LoquiConfig;
  #apiKey: string;
  #fetchFn: RetryOptions['fetchFn'];
  #sleepFn: RetryOptions['sleepFn'];

  constructor(config: LoquiConfig, apiKey: string) {
    this.config = config;
    this.#apiKey = apiKey;
  }

  getApiKey(): string {
    return this.#apiKey;
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

  /** The retry options a call shares: this call's log and 429 signal, and the test-injected transport. */
  protected retryHooks(ctx: CallContext): Pick<RetryOptions, 'fetchFn' | 'sleepFn' | 'log' | 'onRateLimited'> {
    return { fetchFn: this.#fetchFn, sleepFn: this.#sleepFn, log: ctx.log, onRateLimited: ctx.onRateLimited };
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
    ctx: CallContext,
  ): Promise<Record<string, TranslationResult>>;

  translateChunk(req: TranslateChunkRequest): Promise<Record<string, TranslationResult>> {
    const { chunk, targetLocales, sourceLocale } = req;
    return this.makeCall(
      this.#systemPromptFor(req),
      this.buildUserPrompt(chunk, targetLocales, sourceLocale),
      Object.keys(chunk.keys),
      targetLocales,
      req,
    );
  }

  reviewChunk(req: ReviewChunkRequest): Promise<Record<string, TranslationResult>> {
    const { chunk, initial, targetLocales, sourceLocale } = req;
    return this.makeCall(
      this.#systemPromptFor(req),
      this.buildReviewPrompt(chunk, initial, targetLocales, sourceLocale),
      Object.keys(chunk.keys),
      targetLocales,
      req,
    );
  }

  #systemPromptFor({ targetLocales, sourceLocale, namespace, glossaryBlock = '' }: TranslateChunkRequest): string {
    const system = this.buildSystemPrompt(targetLocales, sourceLocale, namespace);
    return glossaryBlock ? `${system}\n${glossaryBlock}` : system;
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
    ctx: CallContext,
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

    return this.extractTranslations(parsed, expectedKeys, targetLocales, ctx);
  }

  protected extractTranslations(
    parsed: Record<string, unknown>,
    expectedKeys: string[],
    targetLocales: string[],
    ctx: CallContext,
  ): Record<string, TranslationResult> {
    const result: Record<string, TranslationResult> = {};
    for (const locale of targetLocales) {
      const localeData = parsed[locale];
      if (!localeData || typeof localeData !== 'object') {
        ctx.log('warn', `Engine response missing locale "${locale}" — all ${expectedKeys.length} key(s) will be empty`);
        result[locale] = {
          keys: Object.fromEntries(expectedKeys.map((k) => [k, ''])),
        };
        continue;
      }
      const keys: Record<string, string> = {};
      for (const key of expectedKeys) {
        const val = (localeData as Record<string, unknown>)[key];
        if (typeof val !== 'string') {
          ctx.log(
            'warn',
            `Engine response key "${key}" for locale "${locale}" is not a string (got ${typeof val}) — using empty string`,
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
