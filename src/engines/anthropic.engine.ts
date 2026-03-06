import { BaseEngine } from './base.engine.js';
import { TranslationChunk, TranslationResult, LoquiConfig } from '../types.js';
import { sleep, truncate } from './utils.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_API_VERSION = '2023-06-01';
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

    const body = {
      model,
      max_tokens: 8192,
      temperature: this.config.temperature,
      top_p: this.config.topP,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    };

    let attempt = 0;
    while (true) {
      const response = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify(body),
      });

      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Anthropic API 429 after ${MAX_RETRIES} retries.`);
        }
        const retryAfter = response.headers.get('retry-after');
        const parsedSeconds = retryAfter ? parseInt(retryAfter, 10) : NaN;
        const waitMs = Number.isFinite(parsedSeconds) ? parsedSeconds * 1000 + 500 : 60_000;
        process.stderr.write(
          `\x1b[2m [retry] 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...\x1b[0m\n`
        );
        await sleep(waitMs);
        attempt++;
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      const raw = data?.content?.[0]?.text;
      if (!raw) throw new Error(`Anthropic returned empty response: ${truncate(JSON.stringify(data))}`);

      return this.parseResponse(raw, expectedKeys, targetLocales);
    }
  }
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}
