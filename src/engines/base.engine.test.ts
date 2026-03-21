import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseEngine } from './base.engine.js';
import { LoquiConfig, CONFIG_DEFAULTS, TranslationChunk, TranslationResult } from '../types.js';

class TestableEngine extends BaseEngine {
  constructor(config?: Partial<LoquiConfig>) {
    super({ ...CONFIG_DEFAULTS, ...config });
  }

  parseResponseForTest(
    raw: string,
    expectedKeys: string[],
    targetLocales: string[]
  ) {
    return this.parseResponse(raw, expectedKeys, targetLocales);
  }

  async translateChunk(
    _chunk: TranslationChunk,
    _targetLocales: string[],
    _sourceLocale: string,
    _namespace: string
  ): Promise<Record<string, TranslationResult>> {
    throw new Error('not implemented');
  }
}

describe('parseResponse', () => {
  test('valid response — returns correct locale and key structure', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest(
      '{"fr":{"greeting":"Bonjour","farewell":"Au revoir"},"de":{"greeting":"Hallo","farewell":"Auf Wiedersehen"}}',
      ['greeting', 'farewell'],
      ['fr', 'de']
    );

    assert.equal(result['fr'].keys['greeting'], 'Bonjour');
    assert.equal(result['fr'].keys['farewell'], 'Au revoir');
    assert.equal(result['de'].keys['greeting'], 'Hallo');
    assert.equal(result['de'].keys['farewell'], 'Auf Wiedersehen');
  });

  test('missing locale in response — fills all keys with empty strings', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest(
      '{"fr":{"greeting":"Bonjour"}}',
      ['greeting', 'farewell'],
      ['fr', 'de']
    );

    assert.equal(result['fr'].keys['greeting'], 'Bonjour');
    assert.equal(result['fr'].keys['farewell'], '');
    assert.equal(result['de'].keys['greeting'], '');
    assert.equal(result['de'].keys['farewell'], '');
  });

  test('non-string value for a key — uses empty string', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest(
      '{"fr":{"greeting":"Bonjour","count":42}}',
      ['greeting', 'count'],
      ['fr']
    );

    assert.equal(result['fr'].keys['greeting'], 'Bonjour');
    assert.equal(result['fr'].keys['count'], '');
  });

  test('invalid JSON — throws with descriptive error', () => {
    const engine = new TestableEngine();
    assert.throws(
      () =>
        engine.parseResponseForTest(
          'not valid json at all',
          ['greeting'],
          ['fr']
        ),
      (err: Error) =>
        err.message.includes('Engine returned invalid JSON')
    );
  });

  test('markdown-fenced JSON — strips fences before parsing', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest(
      '```json\n{"fr":{"greeting":"Bonjour"}}\n```',
      ['greeting'],
      ['fr']
    );

    assert.equal(result['fr'].keys['greeting'], 'Bonjour');
  });

  test('triple-backtick fence without language tag — also stripped', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest(
      '```\n{"fr":{"greeting":"Salut"}}\n```',
      ['greeting'],
      ['fr']
    );

    assert.equal(result['fr'].keys['greeting'], 'Salut');
  });
});
