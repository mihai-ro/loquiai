import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chunkTranslations } from './chunk.js';

describe('chunkTranslations — key-count bound', () => {
  function makeFlat(n: number): Record<string, string> {
    return Object.fromEntries(Array.from({ length: n }, (_, i) => [`key${i}`, 'value']));
  }

  test('single locale: allows up to 90 keys per chunk', () => {
    const flat = makeFlat(90);
    const chunks = chunkTranslations(flat, 999_999, 1);
    assert.equal(chunks.length, 1);
    assert.equal(Object.keys(chunks[0].keys).length, 90);
  });

  test('single locale: splits at 91 keys', () => {
    const flat = makeFlat(91);
    const chunks = chunkTranslations(flat, 999_999, 1);
    assert.equal(chunks.length, 2);
  });

  test('10 locales: max 9 keys per chunk (floor(90/10))', () => {
    const flat = makeFlat(10);
    const chunks = chunkTranslations(flat, 999_999, 10);
    assert.equal(chunks.length, 2); // 10 keys → ceil(10/9) = 2 chunks
    assert.ok(Object.keys(chunks[0].keys).length <= 9);
  });

  test('20 locales: max 4 keys per chunk (floor(90/20))', () => {
    const flat = makeFlat(20);
    const chunks = chunkTranslations(flat, 999_999, 20);
    // floor(90/20)=4, so 20 keys → 5 chunks
    assert.equal(chunks.length, 5);
    for (const chunk of chunks) {
      assert.ok(Object.keys(chunk.keys).length <= 4);
    }
  });

  test('token limit still splits before key limit', () => {
    // 2 locales → max 45 keys. But tiny splitToken forces 1 key per chunk.
    const flat = makeFlat(5);
    const chunks = chunkTranslations(flat, 1, 2);
    assert.equal(chunks.length, 5);
  });

  test('single key always produces exactly one chunk regardless of localeCount', () => {
    const chunks = chunkTranslations({ onlyKey: 'val' }, 999_999, 100);
    assert.equal(chunks.length, 1);
    assert.deepEqual(Object.keys(chunks[0].keys), ['onlyKey']);
  });

  test('each chunk has locales × keys ≤ 90', () => {
    const localeCount = 7;
    const flat = makeFlat(50);
    const chunks = chunkTranslations(flat, 999_999, localeCount);
    for (const chunk of chunks) {
      assert.ok(localeCount * Object.keys(chunk.keys).length <= 90);
    }
  });
});
