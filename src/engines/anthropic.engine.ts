import { LoquiError } from '../errors.js';
import type { LoquiConfig, TranslationResult } from '../types.js';
import { BaseEngine } from './base.engine.js';
import { assertComplete, fetchWithRetry, STRUCTURED_OUTPUT_MAX_PROPS, sanitizeForDisplay } from './utils.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const DEFAULT_ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_RETRIES = 5;
// Anthropic has no documented hard limit on tool input_schema size. STRUCTURED_OUTPUT_MAX_PROPS
// mirrors the OpenAI cap for consistency. Above this limit, falls back to prompt-based JSON.

export class AnthropicEngine extends BaseEngine {
  constructor(config: LoquiConfig) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new LoquiError('AUTH', 'ANTHROPIC_API_KEY environment variable is not set.');
    super(config, apiKey);
  }

  protected async makeCall(
    systemPrompt: string,
    userPrompt: string,
    expectedKeys: string[],
    targetLocales: string[],
  ): Promise<Record<string, TranslationResult>> {
    const model = this.config.model || DEFAULT_MODEL;
    const apiVersion = process.env.ANTHROPIC_API_VERSION ?? DEFAULT_ANTHROPIC_API_VERSION;

    const useSchema = targetLocales.length * expectedKeys.length <= STRUCTURED_OUTPUT_MAX_PROPS;

    const body: Record<string, unknown> = {
      model,
      max_tokens: deriveMaxTokens(this.config.splitToken, targetLocales.length),
      temperature: this.config.temperature,
      top_p: this.config.topP,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      ...(useSchema
        ? {
            tools: [buildAnthropicTool(targetLocales, expectedKeys)],
            tool_choice: { type: 'tool', name: 'output_translations' },
          }
        : {}),
    };

    const response = await fetchWithRetry(
      `${ANTHROPIC_API_BASE}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.getApiKey(),
          'anthropic-version': apiVersion,
        },
        body: JSON.stringify(body),
      },
      {
        engineName: 'Anthropic',
        maxRetries: MAX_RETRIES,
        timeoutMs: this.config.timeout ?? 120_000,
        onRateLimited: this.getRateLimitSignal(),
        ...this.retryHooks(),
      },
    );

    const data = (await response.json()) as AnthropicResponse;
    assertComplete(data?.stop_reason, 'Anthropic');

    const toolBlock = data?.content?.find((b) => b.type === 'tool_use');
    if (toolBlock?.input) {
      return this.extractTranslations(toolBlock.input, expectedKeys, targetLocales);
    }

    const raw = data?.content?.find((b) => b.type === 'text')?.text;
    if (!raw)
      throw new LoquiError(
        'INVALID_RESPONSE',
        `Anthropic returned empty response: ${sanitizeForDisplay(JSON.stringify(data))}`,
      );

    return this.parseResponse(raw, expectedKeys, targetLocales);
  }
}

/**
 * Anthropic requires an explicit max_tokens, and a constant one truncates as soon as
 * splitToken or the locale count grows: the reply repeats the chunk once per locale,
 * wrapped in JSON, and a translation usually runs longer than its source. The floor
 * keeps small chunks workable; the ceiling stays inside current model output limits.
 * Past the ceiling the response is cut off, which assertComplete reports as TRUNCATED.
 */
const MIN_OUTPUT_TOKENS = 4_096;
const MAX_OUTPUT_TOKENS = 64_000;
const OUTPUT_OVERHEAD = 1.5;

export function deriveMaxTokens(splitToken: number, localeCount: number): number {
  const estimate = Math.ceil(splitToken * Math.max(localeCount, 1) * OUTPUT_OVERHEAD);
  return Math.min(Math.max(estimate, MIN_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS);
}

/** Builds an Anthropic tool-use input schema for locale → key → string. */
export function buildAnthropicInputSchema(locales: string[], keys: string[]): Record<string, unknown> {
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

function buildAnthropicTool(locales: string[], keys: string[]): Record<string, unknown> {
  return {
    name: 'output_translations',
    description: 'Output the translations as structured data.',
    input_schema: buildAnthropicInputSchema(locales, keys),
  };
}

interface AnthropicResponse {
  content?: Array<{
    type: string;
    text?: string;
    input?: Record<string, unknown>;
    name?: string;
    id?: string;
  }>;
  stop_reason?: string;
}
