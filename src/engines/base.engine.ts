import { inspect } from 'node:util';
import type { LoquiConfig, TranslationChunk, TranslationResult } from '../types.js';
import { sanitizeForDisplay } from './utils.js';

export abstract class BaseEngine {
  protected config: LoquiConfig;
  #apiKey: string;

  constructor(config: LoquiConfig, apiKey: string) {
    this.config = config;
    this.#apiKey = apiKey;
  }

  getApiKey(): string {
    return this.#apiKey;
  }

  [inspect.custom](): string {
    return `${this.constructor.name} { config: ${inspect(this.config, { depth: null })} }`;
  }

  abstract translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string,
  ): Promise<Record<string, TranslationResult>>;

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
      throw new Error(`Engine returned invalid JSON:\n${sanitizeForDisplay(raw)}`);
    }

    const result: Record<string, TranslationResult> = {};
    for (const locale of targetLocales) {
      const localeData = parsed[locale];
      if (!localeData || typeof localeData !== 'object') {
        process.stderr.write(
          `\x1b[33m[❗️] Engine response missing locale "${locale}" — all ${expectedKeys.length} key(s) will be empty\x1b[0m\n`,
        );
        result[locale] = { keys: Object.fromEntries(expectedKeys.map((k) => [k, ''])) };
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
