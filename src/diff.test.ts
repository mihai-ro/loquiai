import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type DiffResult, diffLocales } from './diff.js';

describe('diffLocales', () => {
  test('all keys added (new locale)', () => {
    const source = { 'a.key': 'value', 'b.key': 'other' };
    const existing = { fr: {} };

    const results = diffLocales(source, existing);

    assert.equal(results.length, 1);
    assert.equal(results[0].locale, 'fr');
    assert.deepEqual(results[0].added, ['a.key', 'b.key']);
    assert.deepEqual(results[0].removed, []);
    assert.deepEqual(results[0].changed, []);
    assert.deepEqual(results[0].unchanged, []);
  });

  test('all keys removed', () => {
    const source = { 'a.key': 'value' };
    const existing = { fr: { 'a.key': 'valeur', 'b.key': 'gone' } };

    const results = diffLocales(source, existing);

    assert.equal(results.length, 1);
    assert.equal(results[0].locale, 'fr');
    assert.deepEqual(results[0].added, []);
    assert.deepEqual(results[0].removed, ['b.key']);
    assert.deepEqual(results[0].changed, ['a.key']);
    assert.deepEqual(results[0].unchanged, []);
  });

  test('mixed changes', () => {
    const source = { 'a.key': 'new value', 'b.key': 'also new' };
    const existing = {
      fr: { 'a.key': 'old value', 'c.key': 'removed key', 'd.key': 'stays same' },
    };

    const results = diffLocales(source, existing);

    assert.equal(results.length, 1);
    const fr = results[0];
    assert.deepEqual(fr.added, ['b.key']);
    assert.deepEqual(fr.removed, ['c.key', 'd.key']);
    assert.deepEqual(fr.changed, ['a.key']);
    assert.deepEqual(fr.unchanged, []);
  });

  test('no changes', () => {
    const source = { 'a.key': 'value', 'b.key': 'other' };
    const existing = { fr: { 'a.key': 'value', 'b.key': 'other' } };

    const results = diffLocales(source, existing);

    assert.equal(results.length, 1);
    assert.deepEqual(results[0].added, []);
    assert.deepEqual(results[0].removed, []);
    assert.deepEqual(results[0].changed, []);
    assert.deepEqual(results[0].unchanged, ['a.key', 'b.key']);
  });

  test('multiple locales', () => {
    const source = { 'a.key': 'value' };
    const existing = {
      fr: { 'a.key': 'value' },
      de: { 'b.key': 'gone' },
    };

    const results = diffLocales(source, existing);

    assert.equal(results.length, 2);
    const fr = results.find((r) => r.locale === 'fr') as DiffResult;
    const de = results.find((r) => r.locale === 'de') as DiffResult;

    assert.deepEqual(fr.added, []);
    assert.deepEqual(fr.removed, []);
    assert.deepEqual(fr.changed, []);
    assert.deepEqual(fr.unchanged, ['a.key']);

    assert.deepEqual(de.added, ['a.key']);
    assert.deepEqual(de.removed, ['b.key']);
    assert.deepEqual(de.changed, []);
    assert.deepEqual(de.unchanged, []);
  });

  test('detects changed when source value differs', () => {
    const source = { key: 'hello' };
    const existing = { fr: { key: 'bonjour' } };

    const results = diffLocales(source, existing);

    assert.deepEqual(results[0].changed, ['key']);
    assert.deepEqual(results[0].unchanged, []);
  });

  test('handles empty source', () => {
    const source = {};
    const existing = { fr: { key: 'value' } };

    const results = diffLocales(source, existing);

    assert.deepEqual(results[0].added, []);
    assert.deepEqual(results[0].removed, ['key']);
  });

  test('handles empty target', () => {
    const source = { key: 'value' };
    const existing = { fr: {} };

    const results = diffLocales(source, existing);

    assert.deepEqual(results[0].added, ['key']);
    assert.deepEqual(results[0].removed, []);
  });
});
