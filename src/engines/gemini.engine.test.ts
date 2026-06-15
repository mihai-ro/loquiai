import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { LoquiError } from '../errors.js';
import { CONFIG_DEFAULTS } from '../types.js';
import { buildGeminiResponseSchema, GeminiEngine } from './gemini.engine.js';

const FAKE_KEY = 'gsk_test-gemini-key';
const mockChunk = { keys: { greeting: 'Hello', farewell: 'Goodbye' } };
const successBody = JSON.stringify({
  candidates: [{ content: { parts: [{ text: '{"fr":{"greeting":"Bonjour","farewell":"Au revoir"}}' }] } }],
});

function mockFetch(body: string) {
  return async (_url: string, _init: RequestInit) => new Response(body);
}

describe('GeminiEngine', () => {
  before(() => {
    process.env.GEMINI_API_KEY = FAKE_KEY;
  });
  after(() => {
    delete process.env.GEMINI_API_KEY;
  });

  test('throws LoquiError AUTH when GEMINI_API_KEY is missing', () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      assert.throws(
        () => new GeminiEngine({ ...CONFIG_DEFAULTS, engine: 'gemini' }),
        (err: unknown) => err instanceof LoquiError && err.code === 'AUTH',
      );
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  test('sends request to model-specific URL', async () => {
    const engine = new GeminiEngine({ ...CONFIG_DEFAULTS, engine: 'gemini', model: 'gemini-test' });
    let capturedUrl = '';
    engine._setFetch(async (url) => {
      capturedUrl = url;
      return new Response(successBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  });

  test('sets x-goog-api-key header', async () => {
    const engine = new GeminiEngine({ ...CONFIG_DEFAULTS, engine: 'gemini' });
    let capturedKey = '';
    engine._setFetch(async (_url, init) => {
      capturedKey = (init.headers as Record<string, string>)['x-goog-api-key'];
      return new Response(successBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(capturedKey, FAKE_KEY);
  });

  test('extracts translation from candidates[0].content.parts[0].text', async () => {
    const engine = new GeminiEngine({ ...CONFIG_DEFAULTS, engine: 'gemini' });
    engine._setFetch(mockFetch(successBody));

    const result = await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    assert.equal(result.fr.keys.greeting, 'Bonjour');
    assert.equal(result.fr.keys.farewell, 'Au revoir');
  });

  test('throws when response has no candidates', async () => {
    const engine = new GeminiEngine({ ...CONFIG_DEFAULTS, engine: 'gemini' });
    engine._setFetch(mockFetch(JSON.stringify({ candidates: [] })));

    await assert.rejects(
      () => engine.translateChunk(mockChunk, ['fr'], 'en', 'test'),
      (err: unknown) =>
        err instanceof LoquiError && err.code === 'INVALID_RESPONSE' && err.message.includes('empty response'),
    );
  });

  test('omits responseSchema when locales × keys exceeds limit', async () => {
    const engine = new GeminiEngine({ ...CONFIG_DEFAULTS, engine: 'gemini' });
    let capturedBody: Record<string, unknown> = {};
    engine._setFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(successBody);
    });

    // 6 locales × 9 keys = 54 > 50 limit
    const largeChunk = { keys: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`key${i}`, 'val'])) };
    const manyLocales = ['fr', 'de', 'es', 'it', 'pt', 'ja'];
    // success body doesn't matter — we only check the request shape
    engine._setFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify(
                      Object.fromEntries(
                        manyLocales.map((l) => [
                          l,
                          Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`key${i}`, 'translated'])),
                        ]),
                      ),
                    ),
                  },
                ],
              },
            },
          ],
        }),
      );
    });

    await engine.translateChunk(largeChunk, manyLocales, 'en', 'test');
    const genConfig = capturedBody.generationConfig as Record<string, unknown>;
    assert.ok(!('responseSchema' in genConfig), 'responseSchema must be absent above size limit');
    assert.equal(genConfig.responseMimeType, 'application/json');
  });

  test('includes responseSchema when within limit', async () => {
    const engine = new GeminiEngine({ ...CONFIG_DEFAULTS, engine: 'gemini' });
    let capturedBody: Record<string, unknown> = {};
    engine._setFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(successBody);
    });

    await engine.translateChunk(mockChunk, ['fr'], 'en', 'test');
    const genConfig = capturedBody.generationConfig as Record<string, unknown>;
    assert.ok('responseSchema' in genConfig, 'responseSchema must be present within size limit');
  });
});

describe('buildGeminiResponseSchema', () => {
  test('top-level type is OBJECT and required matches locales', () => {
    const schema = buildGeminiResponseSchema(['fr'], ['greeting']);
    assert.equal(schema.type, 'OBJECT');
    assert.deepEqual(schema.required, ['fr']);
  });

  test('each locale property has the correct key schema', () => {
    const schema = buildGeminiResponseSchema(['fr', 'de'], ['title', 'body']);
    const props = schema.properties ?? {};
    const fr = props.fr;
    assert.ok(fr, 'fr locale schema must exist');
    assert.equal(fr.type, 'OBJECT');
    assert.deepEqual((fr.required ?? []).sort(), ['body', 'title']);
    assert.equal(fr.properties?.title?.type, 'STRING');
    assert.equal(fr.properties?.body?.type, 'STRING');
  });

  test('all requested locales appear in schema properties', () => {
    const schema = buildGeminiResponseSchema(['fr', 'de', 'es'], ['key']);
    const props = schema.properties ?? {};
    assert.ok('fr' in props);
    assert.ok('de' in props);
    assert.ok('es' in props);
  });

  test('single locale single key produces minimal valid schema', () => {
    const schema = buildGeminiResponseSchema(['ja'], ['hello']);
    assert.deepEqual(schema.required, ['ja']);
    const jaProp = schema.properties?.ja;
    assert.deepEqual(jaProp?.required, ['hello']);
  });
});
