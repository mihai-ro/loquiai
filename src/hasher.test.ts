import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hashValue, buildUpdatedHashStore } from './hasher.js';

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

describe('buildUpdatedHashStore', () => {
  test('merges new hashes into existing store', () => {
    const existing = { a: 'hash-a' };
    const current = { b: 'hash-b' };
    const result = buildUpdatedHashStore(existing, current);
    assert.equal(result['a'], 'hash-a');
    assert.equal(result['b'], 'hash-b');
  });

  test('current hashes overwrite existing ones', () => {
    const existing = { a: 'old-hash' };
    const current = { a: 'new-hash' };
    const result = buildUpdatedHashStore(existing, current);
    assert.equal(result['a'], 'new-hash');
  });

  test('does not mutate the existing store', () => {
    const existing = { a: 'hash-a' };
    buildUpdatedHashStore(existing, { b: 'hash-b' });
    assert.ok(!('b' in existing));
  });
});
