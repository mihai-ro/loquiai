import { BaseEngine } from './base.engine.js';
import { TranslationChunk, TranslationResult, LoquiConfig } from '../types.js';
import { truncate, fetchWithRetry } from './utils.js';

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

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
      },
      {
        engineName: 'Gemini',
        maxRetries: MAX_RETRIES,
        timeoutMs: this.config.timeout ?? 120_000,
        parseRetryDelay: parseGeminiRetryDelay,
      }
    );

    const data = (await response.json()) as GeminiResponse;
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error(`Gemini returned empty response: ${truncate(JSON.stringify(data))}`);

    return this.parseResponse(raw, expectedKeys, targetLocales);
  }
}

async function parseGeminiRetryDelay(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as GeminiErrorResponse;
    const retryInfo = body?.error?.details?.find((d) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
    if (retryInfo?.retryDelay) {
      const seconds = parseInt(retryInfo.retryDelay.replace('s', ''), 10);
      if (!isNaN(seconds)) return seconds * 1000 + 500;
    }
  } catch {
    /* no server delay */
  }
  return null;
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
