import assertLoose from 'node:assert';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { deepSortKeys, flatten, unflatten, writeJson } from './json.js';

describe('flatten', () => {
  test('flattens a nested object to dot-notation keys', () => {
    const result = flatten({ a: { b: { c: 'val' } } });
    assert.deepEqual(result, { 'a.b.c': 'val' });
  });

  test('handles multiple top-level keys', () => {
    const result = flatten({ x: '1', y: { z: '2' } });
    assert.deepEqual(result, { x: '1', 'y.z': '2' });
  });

  test('coerces null to empty string', () => {
    const result = flatten({ key: null } as never);
    assert.equal(result.key, '');
  });

  test('leaves already-flat objects unchanged', () => {
    const input = { a: 'foo', b: 'bar' };
    assert.deepEqual(flatten(input), input);
  });
});

describe('unflatten', () => {
  test('rebuilds nested structure from dot-notation keys', () => {
    const result = unflatten({ 'a.b.c': 'val' });
    assertLoose.deepEqual(result, { a: { b: { c: 'val' } } });
  });

  test('handles sibling keys at same depth', () => {
    const result = unflatten({ 'a.x': '1', 'a.y': '2' });
    assertLoose.deepEqual(result, { a: { x: '1', y: '2' } });
  });
});

describe('flatten / unflatten roundtrip', () => {
  test('roundtrips deeply nested objects', () => {
    const original = { greetings: { formal: 'Good day', casual: { morning: 'Hey', evening: 'Hi' } } };
    assertLoose.deepEqual(unflatten(flatten(original)), original);
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
