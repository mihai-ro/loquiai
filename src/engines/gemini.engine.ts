import { LoquiError } from '../errors.js';
import type { LoquiConfig, TranslationResult } from '../types.js';
import { BaseEngine } from './base.engine.js';
import { fetchWithRetry, sanitizeForDisplay } from './utils.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRIES = 5;
// gemini rejects schemas above 50 total property nodes (locales × keys).
const SCHEMA_SIZE_LIMIT = 50;

export class GeminiEngine extends BaseEngine {
  constructor(config: LoquiConfig) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new LoquiError('AUTH', 'GEMINI_API_KEY environment variable is not set.');
    super(config, apiKey);
  }

  protected async makeCall(
    systemPrompt: string,
    userPrompt: string,
    expectedKeys: string[],
    targetLocales: string[],
  ): Promise<Record<string, TranslationResult>> {
    const url = `${GEMINI_API_BASE}/${this.config.model}:generateContent`;
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: this.config.temperature,
        topP: this.config.topP,
        responseMimeType: 'application/json',
        // Skip responseSchema when the payload would exceed Gemini's complexity limit.
        ...(targetLocales.length * expectedKeys.length <= SCHEMA_SIZE_LIMIT
          ? {
              responseSchema: buildGeminiResponseSchema(targetLocales, expectedKeys),
            }
          : {}),
      },
    };

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.getApiKey(),
        },
        body: JSON.stringify(body),
      },
      {
        engineName: 'Gemini',
        maxRetries: MAX_RETRIES,
        timeoutMs: this.config.timeout ?? 120_000,
        parseRetryDelay: parseGeminiRetryDelay,
        onRateLimited: this.getRateLimitSignal(),
        ...this.retryHooks(),
      },
    );

    const data = (await response.json()) as GeminiResponse;
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw)
      throw new LoquiError(
        'INVALID_RESPONSE',
        `Gemini returned empty response: ${sanitizeForDisplay(JSON.stringify(data))}`,
      );

    return this.parseResponse(raw, expectedKeys, targetLocales);
  }
}

async function parseGeminiRetryDelay(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as GeminiErrorResponse;
    const retryInfo = body?.error?.details?.find((d) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
    if (retryInfo?.retryDelay) {
      const seconds = parseInt(retryInfo.retryDelay.replace('s', ''), 10);
      if (!Number.isNaN(seconds)) return seconds * 1000 + 500;
    }
  } catch {
    /* no server delay */
  }
  return null;
}

export interface GeminiSchemaNode {
  type: 'STRING' | 'OBJECT';
  properties?: Record<string, GeminiSchemaNode>;
  required?: string[];
}

/** builds a Gemini responseSchema that enforces locale → key → string structure. */
export function buildGeminiResponseSchema(locales: string[], keys: string[]): GeminiSchemaNode {
  const keyProperties: Record<string, GeminiSchemaNode> = {};
  for (const key of keys) {
    keyProperties[key] = { type: 'STRING' };
  }

  const localeProperties: Record<string, GeminiSchemaNode> = {};
  for (const locale of locales) {
    localeProperties[locale] = {
      type: 'OBJECT',
      properties: keyProperties,
      required: keys,
    };
  }

  return {
    type: 'OBJECT',
    properties: localeProperties,
    required: locales,
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

interface GeminiErrorResponse {
  error?: {
    details?: Array<{
      '@type': string;
      retryDelay?: string;
    }>;
  };
}
