import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { EngineAdapter } from '../types.js';
import { CONFIG_DEFAULTS } from '../types.js';
import { createEngine } from './factory.js';

describe('createEngine', () => {
  test('returns engineOverride when provided', async () => {
    const override = { translateChunk: async () => ({}) } as EngineAdapter;
    const result = await createEngine({ ...CONFIG_DEFAULTS }, override);
    assert.equal(result, override);
  });

  describe('engine routing', () => {
    before(() => {
      process.env.GEMINI_API_KEY = 'test-key';
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.ANTHROPIC_API_KEY = 'test-key';
    });
    after(() => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    });

    test('creates GeminiEngine for gemini config', async () => {
      const { GeminiEngine } = await import('./gemini.engine.js');
      const engine = await createEngine({ ...CONFIG_DEFAULTS, engine: 'gemini' });
      assert.ok(engine instanceof GeminiEngine);
    });

    test('creates OpenAIEngine for openai config', async () => {
      const { OpenAIEngine } = await import('./openai.engine.js');
      const engine = await createEngine({ ...CONFIG_DEFAULTS, engine: 'openai' });
      assert.ok(engine instanceof OpenAIEngine);
    });

    test('creates AnthropicEngine for anthropic config', async () => {
      const { AnthropicEngine } = await import('./anthropic.engine.js');
      const engine = await createEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic' });
      assert.ok(engine instanceof AnthropicEngine);
    });
  });
});
