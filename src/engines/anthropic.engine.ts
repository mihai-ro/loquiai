import type { LoquiConfig, TranslationChunk, TranslationResult } from '../types.js';
import { BaseEngine } from './base.engine.js';
import { fetchWithRetry, sanitizeForDisplay } from './utils.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const DEFAULT_ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_RETRIES = 5;

export class AnthropicEngine extends BaseEngine {
  constructor(config: LoquiConfig) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
    super(config, apiKey);
  }

  async translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string,
  ): Promise<Record<string, TranslationResult>> {
    const expectedKeys = Object.keys(chunk.keys);
    const systemPrompt = this.buildSystemPrompt(targetLocales, sourceLocale, namespace);
    const userPrompt = this.buildUserPrompt(chunk, targetLocales, sourceLocale);
    const model = this.config.model || DEFAULT_MODEL;
    const apiVersion = process.env.ANTHROPIC_API_VERSION ?? DEFAULT_ANTHROPIC_API_VERSION;

    const body = {
      model,
      max_tokens: 8192,
      temperature: this.config.temperature,
      top_p: this.config.topP,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
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
      },
    );

    const data = (await response.json()) as AnthropicResponse;
    const raw = data?.content?.[0]?.text;
    if (!raw) throw new Error(`Anthropic returned empty response: ${sanitizeForDisplay(JSON.stringify(data))}`);

    return this.parseResponse(raw, expectedKeys, targetLocales);
  }
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}
