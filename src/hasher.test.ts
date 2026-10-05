import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { buildUpdatedHashes, hashValue, loadHashStore } from './hasher.js';

describe('hashValue', () => {
  test('same input produces same hash', () => {
    assert.equal(hashValue('hello'), hashValue('hello'));
  });

  test('different inputs produce different hashes', () => {
    assert.notEqual(hashValue('hello'), hashValue('world'));
  });

  test('returns a non-empty string', () => {
    assert.ok(hashValue('x').length > 0);
  });
});

describe('buildUpdatedHashes', () => {
  const never = () => false;

  test('records the current hash for every key a locale owes nothing for', () => {
    const result = buildUpdatedHashes({}, ['es'], { a: 'ha', b: 'hb' }, never);
    assert.deepEqual(result, { es: { a: 'ha', b: 'hb' } });
  });

  test('a key a locale still owes keeps its old hash, or none', () => {
    const owes = (_locale: string, key: string) => key !== 'a';
    const result = buildUpdatedHashes({ es: { b: 'old-b' } }, ['es'], { a: 'ha', b: 'hb', c: 'hc' }, owes);
    assert.deepEqual(result, { es: { a: 'ha', b: 'old-b' } });
  });

  test('decides per locale', () => {
    const esOwes = (locale: string) => locale === 'es';
    const result = buildUpdatedHashes({ es: { a: 'old' }, pt: { a: 'old' } }, ['es', 'pt'], { a: 'new' }, esOwes);
    assert.deepEqual(result, { es: { a: 'old' }, pt: { a: 'new' } });
  });

  test('prunes keys the source no longer has', () => {
    const result = buildUpdatedHashes({ es: { kept: 'k', deleted: 'd' } }, ['es'], { kept: 'k' }, never);
    assert.deepEqual(result, { es: { kept: 'k' } });
  });

  test('locales outside `to` pass through untouched', () => {
    const previous = { de: { gone: 'g' } };
    const result = buildUpdatedHashes(previous, ['es'], { a: 'ha' }, never);
    assert.deepEqual(result, { de: { gone: 'g' }, es: { a: 'ha' } });
  });

  test('does not mutate the previous sidecar', () => {
    const previous = { es: { a: 'old' } };
    buildUpdatedHashes(previous, ['es'], { a: 'new' }, never);
    assert.deepEqual(previous, { es: { a: 'old' } });
  });
});

describe('loadHashStore', () => {
  function sidecar(content: unknown): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-hash-')), 'hash.json');
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  }

  test('reads a per-locale sidecar as it is', () => {
    const file = sidecar({ es: { a: 'ha' }, de: { a: 'hb' } });
    assert.deepEqual(loadHashStore(file, ['es']), { es: { a: 'ha' }, de: { a: 'hb' } });
  });

  test('a v2 flat sidecar applies to every locale in `to`, and to no other', () => {
    const file = sidecar({ a: 'ha', b: 'hb' });
    assert.deepEqual(loadHashStore(file, ['es', 'pt']), {
      es: { a: 'ha', b: 'hb' },
      pt: { a: 'ha', b: 'hb' },
    });
  });
});
