import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildUpdatedHashStore, hashValue } from './hasher.js';

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
    // both keys are still in the source; only b was translated this run
    const result = buildUpdatedHashStore(existing, current, ['a', 'b']);
    assert.equal(result.a, 'hash-a');
    assert.equal(result.b, 'hash-b');
  });

  test('prunes keys the source no longer has', () => {
    const existing = { kept: 'hash-kept', deleted: 'hash-deleted' };
    const current = { kept: 'hash-kept' };

    const result = buildUpdatedHashStore(existing, current);

    assert.equal(result.kept, 'hash-kept');
    assert.ok(!('deleted' in result), 'a key removed from the source must not linger in the sidecar');
  });

  test('keeps a key that is still in the source but failed to translate', () => {
    const existing = { outstanding: 'hash-old' };
    const current = {};

    const result = buildUpdatedHashStore(existing, current, ['outstanding']);

    assert.equal(result.outstanding, 'hash-old', 'an undelivered key is outstanding, not deleted');
  });

  test('defaults to treating the current hashes as the whole source', () => {
    const result = buildUpdatedHashStore({ gone: 'x' }, { here: 'y' });
    assert.deepEqual(result, { here: 'y' });
  });

  test('current hashes overwrite existing ones', () => {
    const existing = { a: 'old-hash' };
    const current = { a: 'new-hash' };
    const result = buildUpdatedHashStore(existing, current);
    assert.equal(result.a, 'new-hash');
  });

  test('does not mutate the existing store', () => {
    const existing = { a: 'hash-a' };
    buildUpdatedHashStore(existing, { b: 'hash-b' });
    assert.ok(!('b' in existing));
  });
});
