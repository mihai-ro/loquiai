import { BaseEngine } from './base.engine.js';
import { TranslationChunk, TranslationResult, LoquiConfig } from '../types.js';
import { truncate, fetchWithRetry } from './utils.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const DEFAULT_ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_RETRIES = 5;

export class AnthropicEngine extends BaseEngine {
  private apiKey: string;

  constructor(config: LoquiConfig) {
    super(config);
    const key = process.env['ANTHROPIC_API_KEY'];
    if (!key) throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
    this.apiKey = key;
  }

  async translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string
  ): Promise<Record<string, TranslationResult>> {
    const expectedKeys = Object.keys(chunk.keys);
    const systemPrompt = this.buildSystemPrompt(targetLocales, sourceLocale, namespace);
    const userPrompt = this.buildUserPrompt(chunk, targetLocales, sourceLocale);
    const model = this.config.model || DEFAULT_MODEL;
    const apiVersion = process.env['ANTHROPIC_API_VERSION'] ?? DEFAULT_ANTHROPIC_API_VERSION;

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
          'x-api-key': this.apiKey,
          'anthropic-version': apiVersion,
        },
        body: JSON.stringify(body),
      },
      {
        engineName: 'Anthropic',
        maxRetries: MAX_RETRIES,
        timeoutMs: this.config.timeout ?? 120_000,
      }
    );

    const data = (await response.json()) as AnthropicResponse;
    const raw = data?.content?.[0]?.text;
    if (!raw) throw new Error(`Anthropic returned empty response: ${truncate(JSON.stringify(data))}`);

    return this.parseResponse(raw, expectedKeys, targetLocales);
  }
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}
