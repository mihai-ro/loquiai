import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type DiffResult, diffLocales } from './diff.js';
import { hashValue } from './hasher.js';

/** The sidecar as it would look after a run over `source`. */
function hashesFor(source: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(source).map(([k, v]) => [k, hashValue(v)]));
}

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

    const results = diffLocales(source, existing, hashesFor(source));

    assert.equal(results.length, 1);
    assert.equal(results[0].locale, 'fr');
    assert.deepEqual(results[0].added, []);
    assert.deepEqual(results[0].removed, ['b.key']);
    assert.deepEqual(results[0].changed, [], 'a translated value is not a changed source');
    assert.deepEqual(results[0].unchanged, ['a.key']);
  });

  test('mixed changes', () => {
    const source = { 'a.key': 'new value', 'b.key': 'also new' };
    // the sidecar remembers a.key as it was before this edit
    const hashStore = { 'a.key': hashValue('old source'), 'b.key': hashValue('also new') };
    const existing = {
      fr: { 'a.key': 'ancienne valeur', 'c.key': 'removed key', 'd.key': 'stays same' },
    };

    const results = diffLocales(source, existing, hashStore);

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

  test('a correctly translated key is unchanged, not changed', () => {
    const source = { key: 'hello' };
    const existing = { fr: { key: 'bonjour' } };

    const results = diffLocales(source, existing, hashesFor(source));

    assert.deepEqual(results[0].changed, []);
    assert.deepEqual(results[0].unchanged, ['key']);
  });

  test('detects changed when the source text moved since the last run', () => {
    const source = { key: 'hello there' };
    const existing = { fr: { key: 'bonjour' } };
    const hashStore = { key: hashValue('hello') };

    const results = diffLocales(source, existing, hashStore);

    assert.deepEqual(results[0].changed, ['key']);
    assert.deepEqual(results[0].unchanged, []);
  });

  test('reports nothing as changed without a hash store', () => {
    const source = { key: 'hello' };
    const existing = { fr: { key: 'bonjour' } };

    const results = diffLocales(source, existing);

    assert.deepEqual(results[0].changed, [], 'with no record of the previous source, nothing can be called changed');
    assert.deepEqual(results[0].unchanged, ['key']);
  });

  test('a key absent from the hash store is not reported as changed', () => {
    const source = { known: 'a', fresh: 'b' };
    const existing = { fr: { known: 'A', fresh: 'B' } };

    const results = diffLocales(source, existing, { known: hashValue('a') });

    assert.deepEqual(results[0].changed, []);
    assert.deepEqual(results[0].unchanged.sort(), ['fresh', 'known']);
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

  test('a blank target for a source with text is listed as added, not unchanged', () => {
    const source = { title: 'Hello', blank: '' };

    const [fr] = diffLocales(source, { fr: { title: '', blank: '' } }, hashesFor(source));

    assert.deepEqual(fr.added, ['title']);
    assert.deepEqual(fr.unchanged, ['blank']);
    assert.deepEqual(fr.changed, []);
  });
});
