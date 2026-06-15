import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { LoquiError } from '../errors.js';
import { CONFIG_DEFAULTS } from '../types.js';
import { buildOpenAIResponseSchema, OpenAIEngine } from './openai.engine.js';

const FAKE_KEY = 'sk-test-openai-key';
const mockChunk = { keys: { title: 'Hello', body: 'World' } };
const successBody = JSON.stringify({
  choices: [{ message: { content: '{"fr":{"title":"Bonjour","body":"Monde"}}' }, finish_reason: 'stop' }],
});

function mockFetch(body: string, status = 200) {
  return async (_url: string, _init: RequestInit) => new Response(body, { status });
}

describe('OpenAIEngine', () => {
  before(() => {
    process.env.OPENAI_API_KEY = FAKE_KEY;
  });
  after(() => {
    delete process.env.OPENAI_API_KEY;
  });

  test('throws LoquiError AUTH when OPENAI_API_KEY is missing', () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      assert.throws(
        () => new OpenAIEngine({ ...CONFIG_DEFAULTS, engine: 'openai' }),
        (err: unknown) => err instanceof LoquiError && err.code === 'AUTH',
      );
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  test('sends request to correct URL', async () => {
    const engine = new OpenAIEngine({ ...CONFIG_DEFAULTS, engine: 'openai' });
    let capturedUrl = '';
    engine._setFetch(async (url) => {
      capturedUrl = url;
      return new Response(successBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions');
  });

  test('sets Bearer auth header', async () => {
    const engine = new OpenAIEngine({ ...CONFIG_DEFAULTS, engine: 'openai' });
    let capturedAuth = '';
    engine._setFetch(async (_url, init) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return new Response(successBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(capturedAuth, `Bearer ${FAKE_KEY}`);
  });

  test('sends system and user messages with json_schema response format within size limit', async () => {
    const engine = new OpenAIEngine({ ...CONFIG_DEFAULTS, engine: 'openai', model: 'gpt-test' });
    let capturedBody: Record<string, unknown> = {};
    engine._setFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(successBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(capturedBody.model, 'gpt-test');
    const messages = capturedBody.messages as Array<{ role: string }>;
    assert.ok(
      messages.some((m) => m.role === 'system'),
      'must have system message',
    );
    assert.ok(
      messages.some((m) => m.role === 'user'),
      'must have user message',
    );
    const rf = capturedBody.response_format as Record<string, unknown>;
    assert.equal(rf.type, 'json_schema');
    const js = rf.json_schema as Record<string, unknown>;
    assert.equal(js.name, 'translations');
    assert.equal(js.strict, true);
    assert.ok(js.schema, 'json_schema.schema must be present');
  });

  test('falls back to json_object when schema exceeds size limit', async () => {
    const engine = new OpenAIEngine({ ...CONFIG_DEFAULTS, engine: 'openai' });
    let capturedBody: Record<string, unknown> = {};
    engine._setFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(successBody);
    });

    // 10 locales × 10 keys = 100 > 90 limit
    const largeChunk = { keys: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key${i}`, 'val'])) };
    const manyLocales = Array.from({ length: 10 }, (_, i) => `l${i}`);
    await engine.translateChunk(largeChunk, manyLocales, 'en', 'test');
    assert.deepEqual(capturedBody.response_format, { type: 'json_object' });
  });

  test('extracts translation from choices[0].message.content', async () => {
    const engine = new OpenAIEngine({ ...CONFIG_DEFAULTS, engine: 'openai' });
    engine._setFetch(mockFetch(successBody));

    const result = await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(result.fr.keys.title, 'Bonjour');
    assert.equal(result.fr.keys.body, 'Monde');
  });

  test('throws when response has no choices', async () => {
    const engine = new OpenAIEngine({ ...CONFIG_DEFAULTS, engine: 'openai' });
    engine._setFetch(mockFetch(JSON.stringify({ choices: [] })));

    await assert.rejects(
      () => engine.translateChunk(mockChunk, ['fr'], 'en', 'test'),
      (err: unknown) =>
        err instanceof LoquiError && err.code === 'INVALID_RESPONSE' && err.message.includes('empty response'),
    );
  });
});

describe('buildOpenAIResponseSchema', () => {
  test('top-level type is object with required locales', () => {
    const schema = buildOpenAIResponseSchema(['fr'], ['greeting']);
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['fr']);
    assert.equal(schema.additionalProperties, false);
  });

  test('each locale has the correct key schema', () => {
    const schema = buildOpenAIResponseSchema(['fr', 'de'], ['title', 'body']);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const fr = props.fr;
    assert.ok(fr, 'fr locale schema must exist');
    assert.equal(fr.type, 'object');
    assert.equal(fr.additionalProperties, false);
    const frRequired = fr.required as string[];
    assert.deepEqual([...frRequired].sort(), ['body', 'title']);
    const frProps = fr.properties as Record<string, { type: string }>;
    assert.equal(frProps.title?.type, 'string');
    assert.equal(frProps.body?.type, 'string');
  });

  test('all requested locales appear in schema properties', () => {
    const schema = buildOpenAIResponseSchema(['fr', 'de', 'es'], ['key']);
    const props = schema.properties as Record<string, unknown>;
    assert.ok('fr' in props);
    assert.ok('de' in props);
    assert.ok('es' in props);
  });

  test('single locale single key produces minimal valid schema', () => {
    const schema = buildOpenAIResponseSchema(['ja'], ['hello']);
    assert.deepEqual(schema.required, ['ja']);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.ja.required as string[], ['hello']);
  });
});
