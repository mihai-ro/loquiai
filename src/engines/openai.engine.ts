import type { LoquiConfig, TranslationChunk, TranslationResult } from '../types.js';
import { BaseEngine } from './base.engine.js';
import { fetchWithRetry, sanitizeForDisplay } from './utils.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const MAX_RETRIES = 5;

export class OpenAIEngine extends BaseEngine {
  constructor(config: LoquiConfig) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set.');
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
          Authorization: `Bearer ${this.getApiKey()}`,
        },
        body: JSON.stringify(body),
      },
      {
        engineName: 'OpenAI',
        maxRetries: MAX_RETRIES,
        timeoutMs: this.config.timeout ?? 120_000,
      },
    );

    const data = (await response.json()) as OpenAIResponse;
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error(`OpenAI returned empty response: ${sanitizeForDisplay(JSON.stringify(data))}`);

    return this.parseResponse(raw, expectedKeys, targetLocales);
  }
}

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
}
