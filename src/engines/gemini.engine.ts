import { BaseEngine } from './base.engine.js';
import { TranslationChunk, TranslationResult, LoquiConfig } from '../types.js';
import { sleep, truncate } from './utils.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRIES = 5;

export class GeminiEngine extends BaseEngine {
  private apiKey: string;

  constructor(config: LoquiConfig) {
    super(config);
    const key = process.env['GEMINI_API_KEY'];
    if (!key) throw new Error('GEMINI_API_KEY environment variable is not set.');
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
    const url = `${GEMINI_API_BASE}/${this.config.model}:generateContent`;
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: this.config.temperature,
        topP: this.config.topP,
        responseMimeType: 'application/json',
      },
    };

    let attempt = 0;
    while (true) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
      });

      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(
            `Gemini API 429 after ${MAX_RETRIES} retries. Upgrade to a paid API key or reduce concurrency.`
          );
        }
        const waitMs = await parseRetryDelay(response);
        process.stderr.write(
          `\x1b[2m [retry] 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...\x1b[0m\n`
        );
        await sleep(waitMs);
        attempt++;
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as GeminiResponse;
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error(`Gemini returned empty response: ${truncate(JSON.stringify(data))}`);

      return this.parseResponse(raw, expectedKeys, targetLocales);
    }
  }
}

async function parseRetryDelay(response: Response): Promise<number> {
  const fallback = 60_000;
  try {
    const body = (await response.json()) as GeminiErrorResponse;
    const retryInfo = body?.error?.details?.find((d) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
    if (retryInfo?.retryDelay) {
      const seconds = parseInt(retryInfo.retryDelay.replace('s', ''), 10);
      if (!isNaN(seconds)) return seconds * 1000 + 500;
    }
  } catch {
    /* use fallback */
  }
  return fallback;
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
