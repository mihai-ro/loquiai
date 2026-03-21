import { BaseEngine } from './base.engine.js';
import { TranslationChunk, TranslationResult, LoquiConfig } from '../types.js';
import { truncate, fetchWithRetry } from './utils.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const MAX_RETRIES = 5;

export class OpenAIEngine extends BaseEngine {
  private apiKey: string;

  constructor(config: LoquiConfig) {
    super(config);
    const key = process.env['OPENAI_API_KEY'];
    if (!key) throw new Error('OPENAI_API_KEY environment variable is not set.');
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
    const body = {
      model: this.config.model,
      temperature: this.config.temperature,
      top_p: this.config.topP,
      response_format: { type: 'json_object' },
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
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      {
        engineName: 'OpenAI',
        maxRetries: MAX_RETRIES,
        timeoutMs: this.config.timeout ?? 120_000,
      }
    );

    const data = (await response.json()) as OpenAIResponse;
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error(`OpenAI returned empty response: ${truncate(JSON.stringify(data))}`);

    return this.parseResponse(raw, expectedKeys, targetLocales);
  }
}

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
}
