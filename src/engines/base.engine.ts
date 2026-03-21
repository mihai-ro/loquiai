import { TranslationChunk, TranslationResult, LoquiConfig } from '../types.js';

export abstract class BaseEngine {
  protected config: LoquiConfig;

  constructor(config: LoquiConfig) {
    this.config = config;
  }

  abstract translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string
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
      ? 'You are working on: ' + this.config.context
      : 'You are working on a professional software application.';

    return [
      'You are a professional software localization engine.',
      domainContext,
      'You are translating the "' + namespace + '" module from "' + sourceLocale + '" into multiple languages.',
      '',
      'Rules you MUST follow without exception:',
      '1. Respond ONLY with a valid JSON object. No markdown, no code fences, no explanation.',
      '2. The top-level keys must be exactly the locale codes: ' + localeList + '.',
      '3. Each locale key maps to an object with the same keys as the input. Do not add, remove, or rename keys.',
      '4. Some values contain tokens wrapped in special brackets like \u27e60\u27e7 or \u27e61\u27e7. These are runtime placeholders. Copy them character-for-character. Never resolve, translate, or substitute them with their actual values.',
      '5. Translate only the human-readable text around those tokens.',
      '6. Preserve capitalization style where natural in the target language.',
      '7. Keep translations concise — this is UI copy, not prose.',
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

    return (
      'Translate the following JSON from "' +
      sourceLocale +
      '" into: ' +
      targetLocales.join(', ') +
      '.\n\n' +
      'Return a JSON object where each top-level key is a locale code and its value is the translated flat JSON with the same keys as the input.\n\n' +
      'Input:\n' +
      json
    );
  }

  protected parseResponse(
    raw: string,
    expectedKeys: string[],
    targetLocales: string[]
  ): Record<string, TranslationResult> {
    const cleaned = raw
      .replace(/^```(?:json)?\n/i, '')
      .replace(/\n```$/, '')
      .trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('Engine returned invalid JSON:\n' + raw.slice(0, 500));
    }

    const result: Record<string, TranslationResult> = {};
    for (const locale of targetLocales) {
      const localeData = parsed[locale];
      if (!localeData || typeof localeData !== 'object') {
        process.stderr.write(
          `\x1b[33m[❗️] Engine response missing locale "${locale}" — all ${expectedKeys.length} key(s) will be empty\x1b[0m\n`
        );
        result[locale] = { keys: Object.fromEntries(expectedKeys.map((k) => [k, ''])) };
        continue;
      }
      const keys: Record<string, string> = {};
      for (const key of expectedKeys) {
        const val = (localeData as Record<string, unknown>)[key];
        if (typeof val !== 'string') {
          process.stderr.write(
            `\x1b[33m[❗️] Engine response key "${key}" for locale "${locale}" is not a string (got ${typeof val}) — using empty string\x1b[0m\n`
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
