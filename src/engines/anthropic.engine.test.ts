import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { LoquiError } from '../errors.js';
import { CONFIG_DEFAULTS } from '../types.js';
import { AnthropicEngine, buildAnthropicInputSchema } from './anthropic.engine.js';

const FAKE_KEY = 'sk-test-anthropic-key';
const mockChunk = { keys: { greeting: 'Hello', farewell: 'Goodbye' } };

// Primary success response uses tool_use (within size limit: 1 locale × 2 keys = 2 ≤ 90).
const toolUseBody = JSON.stringify({
  content: [
    {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'output_translations',
      input: { fr: { greeting: 'Bonjour', farewell: 'Au revoir' } },
    },
  ],
  stop_reason: 'tool_use',
});

// Fallback text response for when schema exceeds size limit.
const textBody = JSON.stringify({
  content: [{ type: 'text', text: '{"fr":{"greeting":"Bonjour","farewell":"Au revoir"}}' }],
});

function mockFetch(body: string, status = 200) {
  return async (_url: string, _init: RequestInit) => new Response(body, { status });
}

describe('AnthropicEngine', () => {
  before(() => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  });
  after(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('throws LoquiError AUTH when ANTHROPIC_API_KEY is missing', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.throws(
        () => new AnthropicEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic' }),
        (err: unknown) => err instanceof LoquiError && err.code === 'AUTH',
      );
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('sends request to correct URL', async () => {
    const engine = new AnthropicEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic' });
    let capturedUrl = '';
    engine._setFetch(async (url) => {
      capturedUrl = url;
      return new Response(toolUseBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
  });

  test('sets x-api-key and anthropic-version headers', async () => {
    const engine = new AnthropicEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic' });
    let capturedHeaders: Record<string, string> = {};
    engine._setFetch(async (_url, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return new Response(toolUseBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(capturedHeaders['x-api-key'], FAKE_KEY);
    assert.ok(capturedHeaders['anthropic-version'], 'anthropic-version header must be present');
    assert.equal(capturedHeaders['content-type'], 'application/json');
  });

  test('includes model, messages, tools, and tool_choice in request body within size limit', async () => {
    const engine = new AnthropicEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic', model: 'claude-test-model' });
    let capturedBody: Record<string, unknown> = {};
    engine._setFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(toolUseBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(capturedBody.model, 'claude-test-model');
    assert.ok(Array.isArray(capturedBody.messages), 'body must have messages array');
    assert.ok(typeof capturedBody.system === 'string', 'body must have system prompt');
    assert.ok(Array.isArray(capturedBody.tools), 'body must include tools');
    const toolChoice = capturedBody.tool_choice as Record<string, unknown>;
    assert.equal(toolChoice.type, 'tool');
    assert.equal(toolChoice.name, 'output_translations');
  });

  test('omits tools when schema exceeds size limit', async () => {
    const engine = new AnthropicEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic' });
    let capturedBody: Record<string, unknown> = {};
    engine._setFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(textBody);
    });

    // 10 locales × 10 keys = 100 > 90 limit
    const largeChunk = { keys: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key${i}`, 'val'])) };
    const manyLocales = Array.from({ length: 10 }, (_, i) => `l${i}`);
    await engine.translateChunk(largeChunk, manyLocales, 'en', 'test');
    assert.ok(!('tools' in capturedBody), 'tools must be absent above size limit');
    assert.ok(!('tool_choice' in capturedBody), 'tool_choice must be absent above size limit');
  });

  test('extracts translation from tool_use input', async () => {
    const engine = new AnthropicEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic' });
    engine._setFetch(mockFetch(toolUseBody));

    const result = await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(result.fr.keys.greeting, 'Bonjour');
    assert.equal(result.fr.keys.farewell, 'Au revoir');
  });

  test('falls back to text content when no tool_use block', async () => {
    const engine = new AnthropicEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic' });
    engine._setFetch(mockFetch(textBody));

    // Must use large chunk to bypass tool-use path (size limit exceeded → text fallback)
    const largeChunk = { keys: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key${i}`, 'val'])) };
    const manyLocales = Array.from({ length: 10 }, (_, i) => `l${i}`);
    // Override textBody to return appropriate locale keys for this large chunk
    const largeTextBody = JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            Object.fromEntries(
              manyLocales.map((l) => [
                l,
                Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key${i}`, `val_${l}`])),
              ]),
            ),
          ),
        },
      ],
    });
    engine._setFetch(mockFetch(largeTextBody));

    const result = await engine.translateChunk(largeChunk, manyLocales, 'en', 'test');
    assert.equal(result.l0.keys.key0, 'val_l0');
  });

  test('throws when response has no content', async () => {
    const engine = new AnthropicEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic' });
    engine._setFetch(mockFetch(JSON.stringify({ content: [] })));

    await assert.rejects(
      () => engine.translateChunk(mockChunk, ['fr'], 'en', 'test'),
      (err: unknown) =>
        err instanceof LoquiError && err.code === 'INVALID_RESPONSE' && err.message.includes('empty response'),
    );
  });

  test('uses ANTHROPIC_API_VERSION env override', async () => {
    process.env.ANTHROPIC_API_VERSION = '2024-01-01';
    const engine = new AnthropicEngine({ ...CONFIG_DEFAULTS, engine: 'anthropic' });
    let capturedVersion = '';
    engine._setFetch(async (_url, init) => {
      capturedVersion = (init.headers as Record<string, string>)['anthropic-version'];
      return new Response(toolUseBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(capturedVersion, '2024-01-01');
    delete process.env.ANTHROPIC_API_VERSION;
  });
});

describe('buildAnthropicInputSchema', () => {
  test('top-level type is object with required locales', () => {
    const schema = buildAnthropicInputSchema(['fr'], ['greeting']);
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['fr']);
  });

  test('each locale has the correct key schema', () => {
    const schema = buildAnthropicInputSchema(['fr', 'de'], ['title', 'body']);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const fr = props.fr;
    assert.ok(fr, 'fr locale schema must exist');
    assert.equal(fr.type, 'object');
    const frRequired = fr.required as string[];
    assert.deepEqual([...frRequired].sort(), ['body', 'title']);
    const frProps = fr.properties as Record<string, { type: string }>;
    assert.equal(frProps.title?.type, 'string');
    assert.equal(frProps.body?.type, 'string');
  });

  test('all requested locales appear in schema properties', () => {
    const schema = buildAnthropicInputSchema(['fr', 'de', 'es'], ['key']);
    const props = schema.properties as Record<string, unknown>;
    assert.ok('fr' in props);
    assert.ok('de' in props);
    assert.ok('es' in props);
  });
});
