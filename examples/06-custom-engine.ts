/**
 * 06-custom-engine.ts
 *
 * Provide your own LLM engine by implementing the EngineAdapter interface.
 * Useful when you want to use a provider not built into falar, or route
 * requests through your own proxy.
 *
 * This example uses a mock engine that uppercases every value, so you can
 * run it without an API key.
 *
 * Run:
 *   npx ts-node examples/06-custom-engine.ts
 */

import { translate, EngineAdapter, TranslationChunk, TranslationResult } from 'falar';

const mockEngine: EngineAdapter = {
  async translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
  ): Promise<Record<string, TranslationResult>> {
    const result: Record<string, TranslationResult> = {};
    for (const locale of targetLocales) {
      const keys: Record<string, string> = {};
      for (const [k, v] of Object.entries(chunk.keys)) {
        // Replace with your actual API call here
        keys[k] = `[${locale.toUpperCase()}] ${v}`;
      }
      result[locale] = { keys };
    }
    return result;
  },
};

const result = await translate({
  input: JSON.stringify({ greeting: 'Hello', farewell: 'Goodbye' }),
  from: 'en',
  to: ['fr', 'de'],
  engine: mockEngine,
});

for (const [locale, json] of Object.entries(result)) {
  console.log(`\n--- ${locale} ---`);
  console.log(json);
}
