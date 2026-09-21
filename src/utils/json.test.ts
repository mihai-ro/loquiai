import assertLoose from 'node:assert';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { deepSortKeys, flatten, unflatten, writeJson } from './json.js';

/** unflatten builds null-prototype containers, so deepEqual has to be the loose one. */
function roundTrip(original: Record<string, unknown>): void {
  assertLoose.deepEqual(unflatten(flatten(original)), original);
}

describe('flatten', () => {
  test('flattens a nested object to dot-notation keys', () => {
    assert.deepEqual(flatten({ a: { b: { c: 'val' } } }).strings, { 'a.b.c': 'val' });
  });

  test('handles multiple top-level keys', () => {
    assert.deepEqual(flatten({ x: '1', y: { z: '2' } }).strings, { x: '1', 'y.z': '2' });
  });

  test('leaves already-flat objects unchanged', () => {
    const input = { a: 'foo', b: 'bar' };
    assert.deepEqual(flatten(input).strings, input);
  });

  test('keeps non-string leaves out of the translatable strings', () => {
    const doc = flatten({ count: 42, enabled: false, missing: null, label: 'Hello' });

    assert.deepEqual(doc.strings, { label: 'Hello' });
    assert.deepEqual(doc.values, { count: 42, enabled: false, missing: null });
  });

  test('flattens arrays positionally and records the path', () => {
    const doc = flatten({ items: ['alpha', 'beta'] });

    assert.deepEqual(doc.strings, { 'items.0': 'alpha', 'items.1': 'beta' });
    assert.deepEqual(doc.arrayPaths, ['items']);
  });

  test('escapes a separator that is part of the key itself', () => {
    const doc = flatten({ nested: { 'a.b': 'dotted' } });

    assert.deepEqual(doc.strings, { 'nested.a\\.b': 'dotted' });
  });

  test('stores empty containers as leaves so they are not lost', () => {
    const doc = flatten({ xs: [], o: {} });

    assert.deepEqual(doc.strings, {});
    assertLoose.deepEqual(doc.values, { xs: [], o: {} });
  });
});

describe('unflatten', () => {
  test('rebuilds nested structure from dot-notation keys', () => {
    assertLoose.deepEqual(unflatten({ strings: { 'a.b.c': 'val' }, values: {}, arrayPaths: [] }), {
      a: { b: { c: 'val' } },
    });
  });

  test('handles sibling keys at same depth', () => {
    assertLoose.deepEqual(unflatten({ strings: { 'a.x': '1', 'a.y': '2' }, values: {}, arrayPaths: [] }), {
      a: { x: '1', y: '2' },
    });
  });

  test('rebuilds an array where the path says array, an object where it does not', () => {
    const asArray = unflatten({ strings: { 'xs.0': 'a', 'xs.1': 'b' }, values: {}, arrayPaths: ['xs'] });
    const asObject = unflatten({ strings: { 'xs.0': 'a', 'xs.1': 'b' }, values: {}, arrayPaths: [] });

    assert.ok(Array.isArray((asArray as { xs: unknown }).xs));
    assert.ok(!Array.isArray((asObject as { xs: unknown }).xs));
  });

  test('a child path wins over a leaf at the same path, whatever the input order', () => {
    // what an older loqui wrote into a locale file: the array joined into one string
    const doc = {
      strings: { items: 'alpha,beta', 'items.0': 'alpha', 'items.1': 'beta' },
      values: {},
      arrayPaths: ['items'],
    };

    assertLoose.deepEqual(unflatten(doc), { items: ['alpha', 'beta'] });

    const reversed = {
      strings: { 'items.0': 'alpha', 'items.1': 'beta', items: 'alpha,beta' },
      values: {},
      arrayPaths: ['items'],
    };
    assertLoose.deepEqual(unflatten(reversed), { items: ['alpha', 'beta'] });
  });

  test('ignores prototype-polluting key paths', () => {
    const result = unflatten({ strings: { '__proto__.polluted': 'yes', safe: 'ok' }, values: {}, arrayPaths: [] });

    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal((result as { safe: string }).safe, 'ok');
  });
});

describe('flatten / unflatten roundtrip', () => {
  test('roundtrips deeply nested objects', () => {
    roundTrip({ greetings: { formal: 'Good day', casual: { morning: 'Hey', evening: 'Hi' } } });
  });

  test('roundtrips arrays of strings without joining them', () => {
    roundTrip({ items: ['alpha', 'beta'] });
  });

  test('roundtrips arrays of non-strings without stringifying them', () => {
    const result = unflatten(flatten({ nums: [1, 2] })) as { nums: unknown[] };

    assertLoose.deepEqual(result.nums, [1, 2]);
    assert.equal(typeof result.nums[0], 'number', 'numbers in arrays must not become strings');
  });

  test('roundtrips numbers and booleans with their types intact', () => {
    const result = unflatten(flatten({ count: 42, ratio: 0.5, enabled: false })) as Record<string, unknown>;

    assert.equal(result.count, 42);
    assert.equal(typeof result.count, 'number');
    assert.equal(result.ratio, 0.5);
    assert.equal(result.enabled, false);
    assert.equal(typeof result.enabled, 'boolean');
  });

  test('keeps a null-valued key present instead of dropping it', () => {
    const result = unflatten(flatten({ missing: null, other: 'x' })) as Record<string, unknown>;

    assert.ok('missing' in result, 'a null value must not remove its key');
    assert.equal(result.missing, null);
  });

  test('keeps a numeric-looking string a string', () => {
    const result = unflatten(flatten({ version: '42' })) as Record<string, unknown>;

    assert.equal(result.version, '42');
    assert.equal(typeof result.version, 'string', 'a numeric-looking string must not become a number');
  });

  test('roundtrips empty arrays and empty objects', () => {
    roundTrip({ xs: [], o: {}, nested: { inner: [] } });
  });

  test('roundtrips nested arrays', () => {
    roundTrip({ grid: [['a', 'b'], ['c']] });
  });

  test('roundtrips objects inside arrays', () => {
    roundTrip({ people: [{ name: 'Ada', age: 36 }, { name: 'Alan' }] });
  });

  test('roundtrips a key that contains the separator', () => {
    roundTrip({ nested: { 'a.b': 'dotted' } });
  });

  test('keeps a dotted key distinct from the nesting it looks like', () => {
    const dotted = unflatten(flatten({ 'a.b': 'literal' })) as Record<string, unknown>;
    const nested = unflatten(flatten({ a: { b: 'nested' } })) as Record<string, unknown>;

    assert.equal(dotted['a.b'], 'literal');
    assert.equal(dotted.a, undefined);
    assert.equal((nested.a as Record<string, unknown>).b, 'nested');
  });

  test('roundtrips a key that contains a backslash', () => {
    roundTrip({ 'back\\slash': 'x', 'both\\.mixed': 'y' });
  });

  test('roundtrips a document mixing every leaf type', () => {
    roundTrip({
      items: ['alpha', 'beta'],
      count: 42,
      enabled: false,
      missing: null,
      empty: [],
      blank: {},
      nested: { deep: { list: [1, 'two', true, null] } },
      label: 'Hello',
    });
  });

  test('preserves array order when elements are of mixed types', () => {
    const result = unflatten(flatten({ mixed: [1, 'two', true, null] })) as { mixed: unknown[] };
    assertLoose.deepEqual(result.mixed, [1, 'two', true, null]);
  });
});

describe('deepSortKeys', () => {
  test('sorts keys alphabetically at every level', () => {
    const result = deepSortKeys({ z: '1', a: '2', m: { q: '3', b: '4' } });
    assert.deepEqual(Object.keys(result), ['a', 'm', 'z']);
    assert.deepEqual(Object.keys(result.m as object), ['b', 'q']);
  });
});

describe('writeJson — atomic', () => {
  test('writes valid JSON with trailing newline', () => {
    const dest = path.join(os.tmpdir(), `loqui-json-test-${Date.now()}.json`);
    try {
      writeJson(dest, { hello: 'world' });
      const raw = fs.readFileSync(dest, 'utf-8');
      assert.ok(raw.endsWith('\n'), 'should end with newline');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.hello, 'world');
    } finally {
      fs.rmSync(dest, { force: true });
    }
  });

  test('leaves no .tmp file after a successful write', () => {
    const dest = path.join(os.tmpdir(), `loqui-atomic-test-${Date.now()}.json`);
    try {
      writeJson(dest, { key: 'value' });
      assert.ok(!fs.existsSync(`${dest}.tmp`), '.tmp file must not survive a successful write');
    } finally {
      fs.rmSync(dest, { force: true });
    }
  });

  test('destination file contains the written data', () => {
    const dest = path.join(os.tmpdir(), `loqui-data-test-${Date.now()}.json`);
    try {
      writeJson(dest, { a: '1', b: { c: '2' } });
      const parsed = JSON.parse(fs.readFileSync(dest, 'utf-8'));
      assert.equal(parsed.a, '1');
      assert.equal(parsed.b.c, '2');
    } finally {
      fs.rmSync(dest, { force: true });
    }
  });
});
