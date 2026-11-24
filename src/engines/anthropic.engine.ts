import { LoquiError } from '../errors.js';
import type { LoquiConfig, TranslationResult } from '../types.js';
import { BaseEngine, type CallContext } from './base.engine.js';
import { assertComplete, fetchWithRetry, STRUCTURED_OUTPUT_MAX_PROPS, sanitizeForDisplay } from './utils.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const DEFAULT_ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_RETRIES = 5;
// Anthropic has no documented hard limit on tool input_schema size. STRUCTURED_OUTPUT_MAX_PROPS
// mirrors the OpenAI cap for consistency. Above this limit, falls back to prompt-based JSON.

/**
 * Each model's output cap, asked of the Models API once per process: a model that allows
 * fewer than MAX_OUTPUT_TOKENS answers a larger `max_tokens` with a 400. The answer is kept
 * even when it is "unknown" (the lookup failed, or the field is empty): a run then sends
 * what it always did, and does not ask again on every chunk.
 */
const modelCaps = new Map<string, Promise<number | undefined>>();

export class AnthropicEngine extends BaseEngine {
  constructor(config: LoquiConfig) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new LoquiError('AUTH', 'ANTHROPIC_API_KEY environment variable is not set.');
    super(config, apiKey);
  }

  #outputCap(model: string, apiVersion: string, ctx: CallContext): Promise<number | undefined> {
    const known = modelCaps.get(model);
    if (known) return known;
    const lookup = this.#lookUpOutputCap(model, apiVersion, ctx);
    modelCaps.set(model, lookup);
    return lookup;
  }

  async #lookUpOutputCap(model: string, apiVersion: string, ctx: CallContext): Promise<number | undefined> {
    try {
      const info = (await fetchWithRetry(
        `${ANTHROPIC_API_BASE}/models/${encodeURIComponent(model)}`,
        { method: 'GET', headers: { 'x-api-key': this.getApiKey(), 'anthropic-version': apiVersion } },
        { engineName: 'Anthropic', maxRetries: 0, timeoutMs: 10_000, ...this.retryHooks(ctx) },
      )) as { max_tokens?: unknown } | null;
      const cap = info?.max_tokens;
      return typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : undefined;
    } catch (err) {
      ctx.log('debug', `[Anthropic] Could not look up the output limit of ${model}: ${(err as Error).message}`);
      return undefined;
    }
  }

  protected async makeCall(
    systemPrompt: string,
    userPrompt: string,
    expectedKeys: string[],
    targetLocales: string[],
    ctx: CallContext,
  ): Promise<Record<string, TranslationResult>> {
    const model = this.config.model || DEFAULT_MODEL;
    const apiVersion = process.env.ANTHROPIC_API_VERSION ?? DEFAULT_ANTHROPIC_API_VERSION;

    const useSchema = targetLocales.length * expectedKeys.length <= STRUCTURED_OUTPUT_MAX_PROPS;

    const body: Record<string, unknown> = {
      model,
      max_tokens: deriveMaxTokens(this.config.splitToken, await this.#outputCap(model, apiVersion, ctx)),
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

    const data = (await fetchWithRetry(
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
        ...this.retryHooks(ctx),
      },
    )) as AnthropicResponse;
    assertComplete(data?.stop_reason, 'Anthropic');

    const toolBlock = data?.content?.find((b) => b.type === 'tool_use');
    if (toolBlock?.input) {
      return this.extractTranslations(toolBlock.input, expectedKeys, targetLocales, ctx);
    }

    const raw = data?.content?.find((b) => b.type === 'text')?.text;
    if (!raw)
      throw new LoquiError(
        'INVALID_RESPONSE',
        `Anthropic returned empty response: ${sanitizeForDisplay(JSON.stringify(data))}`,
      );

    return this.parseResponse(raw, expectedKeys, targetLocales, ctx);
  }
}

/**
 * Anthropic requires an explicit max_tokens, and a constant one truncates as soon as
 * splitToken grows: the reply wraps every translation in JSON, and a translation
 * usually runs longer than its source. splitToken already budgets the source plus
 * every target locale (see chunkTranslations), so the locale count is not applied a
 * second time. The overhead is headroom over that budget: its `length / 4` token
 * estimate undercounts CJK and Cyrillic, which take more tokens per character. The
 * floor keeps small chunks workable; the ceiling stays inside current model output
 * limits. Past the ceiling the response is cut off, which assertComplete reports as
 * TRUNCATED.
 */
const MIN_OUTPUT_TOKENS = 4_096;
const MAX_OUTPUT_TOKENS = 64_000;
const OUTPUT_OVERHEAD = 3;

export function deriveMaxTokens(splitToken: number, modelCap?: number): number {
  const estimate = Math.ceil(splitToken * OUTPUT_OVERHEAD);
  const wanted = Math.min(Math.max(estimate, MIN_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS);
  // The model's own cap is the last word: a request above it is refused outright.
  return modelCap === undefined ? wanted : Math.min(wanted, modelCap);
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
