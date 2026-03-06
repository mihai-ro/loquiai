/**
 * 07-extend-base-engine.ts
 *
 * Extend BaseEngine to reuse falar's built-in prompt builder and JSON
 * response parser while plugging in a custom HTTP transport.
 *
 * This is the right approach when you want to use a different provider
 * but keep the same prompt structure and parsing logic.
 *
 * Run:
 *   MY_API_KEY=... npx ts-node examples/07-extend-base-engine.ts
 */

import { translate, BaseEngine, FalarConfig, TranslationChunk, TranslationResult } from 'falar';

class MyCustomEngine extends BaseEngine {
  private readonly apiKey: string;

  constructor(config: FalarConfig) {
    super(config);
    const key = process.env['MY_API_KEY'];
    if (!key) throw new Error('MY_API_KEY is not set.');
    this.apiKey = key;
  }

  async translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string,
  ): Promise<Record<string, TranslationResult>> {
    const systemPrompt = this.buildSystemPrompt(targetLocales, sourceLocale, namespace);
    const userPrompt = this.buildUserPrompt(chunk, targetLocales, sourceLocale);

    const response = await fetch('https://api.my-llm-provider.com/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ system: systemPrompt, user: userPrompt }),
    });

    if (!response.ok) throw new Error(`API error ${response.status}`);

    const data = (await response.json()) as { text: string };

    // parseResponse handles JSON extraction, key validation, and locale mapping
    return this.parseResponse(data.text, Object.keys(chunk.keys), targetLocales);
  }
}

const config: FalarConfig = {
  engine: 'gemini',     // ignored — we're providing our own engine
  model: 'my-model',
  temperature: 0.1,
  topP: 1,
  concurrency: 4,
  splitToken: 4000,
};

await translate({
  input: './en.json',
  from: 'en',
  to: ['fr', 'de'],
  engine: new MyCustomEngine(config),
  config,
});
