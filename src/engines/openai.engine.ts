import { LoquiError } from '../errors.js';
import type { LoquiConfig, TranslationResult } from '../types.js';
import { BaseEngine } from './base.engine.js';
import { fetchWithRetry, STRUCTURED_OUTPUT_MAX_PROPS, sanitizeForDisplay } from './utils.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const MAX_RETRIES = 5;

export class OpenAIEngine extends BaseEngine {
  constructor(config: LoquiConfig) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new LoquiError('AUTH', 'OPENAI_API_KEY environment variable is not set.');
    super(config, apiKey);
  }

  protected async makeCall(
    systemPrompt: string,
    userPrompt: string,
    expectedKeys: string[],
    targetLocales: string[],
  ): Promise<Record<string, TranslationResult>> {
    const useSchema = targetLocales.length * expectedKeys.length <= STRUCTURED_OUTPUT_MAX_PROPS;
    const response_format = useSchema
      ? {
          type: 'json_schema',
          json_schema: {
            name: 'translations',
            schema: buildOpenAIResponseSchema(targetLocales, expectedKeys),
            strict: true,
          },
        }
      : { type: 'json_object' };

    const body = {
      model: this.config.model,
      temperature: this.config.temperature,
      top_p: this.config.topP,
      response_format,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };

    const response = await fetchWithRetry(
      `${OPENAI_API_BASE}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.getApiKey()}`,
        },
        body: JSON.stringify(body),
      },
      {
        engineName: 'OpenAI',
        maxRetries: MAX_RETRIES,
        timeoutMs: this.config.timeout ?? 120_000,
        onRateLimited: this.getRateLimitSignal(),
        ...this.retryHooks(),
      },
    );

    const data = (await response.json()) as OpenAIResponse;
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw)
      throw new LoquiError(
        'INVALID_RESPONSE',
        `OpenAI returned empty response: ${sanitizeForDisplay(JSON.stringify(data))}`,
      );

    return this.parseResponse(raw, expectedKeys, targetLocales);
  }
}

/** Builds an OpenAI Structured Outputs JSON schema (strict mode) for locale → key → string. */
export function buildOpenAIResponseSchema(locales: string[], keys: string[]): Record<string, unknown> {
  const localeProperties: Record<string, unknown> = {};
  for (const locale of locales) {
    const keyProps: Record<string, { type: 'string' }> = {};
    for (const key of keys) keyProps[key] = { type: 'string' };
    localeProperties[locale] = {
      type: 'object',
      properties: keyProps,
      required: [...keys],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: localeProperties,
    required: [...locales],
    additionalProperties: false,
  };
}

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
}
