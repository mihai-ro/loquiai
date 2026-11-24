import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LoquiError } from './errors.js';
import { hashValue } from './hasher.js';
import {
  loadTranslationMemory,
  lookupTranslationMemory,
  memoryKey,
  saveTranslationMemory,
  updateTranslationMemory,
} from './translation-memory.js';

describe('translationMemory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-tm-'));
  const tmPath = path.join(tmpDir, 'tm.json');

  after(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('loadTranslationMemory returns empty object when file does not exist', () => {
    assert.deepStrictEqual(loadTranslationMemory('/nonexistent/path.json'), { memory: {}, owners: {} });
  });

  it('loadTranslationMemory loads existing translation memory', () => {
    const data = { [memoryKey('hello', 'greeting')]: { fr: 'bonjour', de: 'hallo' } };
    fs.writeFileSync(tmPath, JSON.stringify(data, null, 2));
    assert.deepStrictEqual(loadTranslationMemory(tmPath).memory, data);
  });

  it('loadTranslationMemory refuses a file with a key in the v2 format, naming the file and loqui migrate', () => {
    fs.writeFileSync(
      tmPath,
      JSON.stringify({
        [memoryKey('hello', 'greeting')]: { fr: 'bonjour' },
        '811c9dc5': { fr: 'old one' },
        e8d4a2b1: { fr: 'old two' },
      }),
    );

    assert.throws(
      () => loadTranslationMemory(tmPath),
      (err: unknown) =>
        err instanceof LoquiError &&
        err.code === 'INVALID_CONFIG' &&
        err.message.includes(tmPath) &&
        err.message.includes('2 translation-memory entries') &&
        err.message.includes('loqui migrate'),
    );
  });

  it('memoryKey is 32 lowercase hex characters and stable', () => {
    assert.match(memoryKey('hello', 'greeting'), /^[0-9a-f]{32}$/);
    assert.strictEqual(memoryKey('hello', 'greeting'), memoryKey('hello', 'greeting'));
    assert.notStrictEqual(memoryKey('hello', 'greeting'), memoryKey('Hello', 'greeting'));
  });

  it('memoryKey tells one string apart by the parent path of its key, and nothing else', () => {
    const save = memoryKey('Save', 'buttons.save');

    assert.notStrictEqual(save, memoryKey('Save', 'menu.save'), 'another parent');
    assert.notStrictEqual(save, memoryKey('Save', 'save'), 'no parent');
    assert.strictEqual(save, memoryKey('Save', 'buttons.keep'), 'a sibling shares the parent');
    assert.strictEqual(memoryKey('Item', 'list.0'), memoryKey('Item', 'list.1'), 'array items share it');
    assert.notStrictEqual(
      memoryKey('Save', 'a\\.b.c'),
      memoryKey('Save', 'a.b.c'),
      'a dot inside a segment is not a level',
    );
  });

  it('memoryKey tells apart two strings whose FNV hashes collide', () => {
    const seen = new Map<string, string>();
    let pair: [string, string] | undefined;
    for (let i = 0; !pair && i < 2_000_000; i++) {
      const candidate = `string ${i}`;
      const hash = hashValue(candidate);
      const earlier = seen.get(hash);
      if (earlier !== undefined) pair = [earlier, candidate];
      else seen.set(hash, candidate);
    }

    assert.ok(pair, 'a 32-bit hash collides within a couple of million strings');
    const [a, b] = pair;
    assert.strictEqual(hashValue(a), hashValue(b));
    assert.notStrictEqual(memoryKey(a, 'k'), memoryKey(b, 'k'));
  });

  it('saveTranslationMemory writes to file', () => {
    const tm = { abc123: { fr: 'bonjour' } };
    saveTranslationMemory(tmPath, tm);
    const content = JSON.parse(fs.readFileSync(tmPath, 'utf-8'));
    assert.deepStrictEqual(content, tm);
  });

  it('lookupTranslationMemory returns translations when all locales present', () => {
    const tm = { abc123: { fr: 'bonjour', de: 'hallo' } };
    const result = lookupTranslationMemory(tm, 'abc123', ['fr', 'de']);
    assert.deepStrictEqual(result, { fr: 'bonjour', de: 'hallo' });
  });

  it('lookupTranslationMemory returns the locales it has when one is missing', () => {
    const tm = { abc123: { fr: 'bonjour' } };
    const result = lookupTranslationMemory(tm, 'abc123', ['fr', 'de']);
    assert.deepStrictEqual(result, { fr: 'bonjour' }, 'de going to the engine must not cost fr its cached hit');
  });

  it('lookupTranslationMemory returns null when no requested locale is cached', () => {
    const tm = { abc123: { es: 'hola' } };
    const result = lookupTranslationMemory(tm, 'abc123', ['fr', 'de']);
    assert.strictEqual(result, null);
  });

  it('lookupTranslationMemory returns null when hash not found', () => {
    const tm = { abc123: { fr: 'bonjour' } };
    const result = lookupTranslationMemory(tm, 'notfound', ['fr']);
    assert.strictEqual(result, null);
  });

  it('updateTranslationMemory adds new entry', () => {
    const tm: Record<string, Record<string, string>> = {};
    updateTranslationMemory(tm, 'abc123', { fr: 'bonjour', de: 'hallo' });
    assert.deepStrictEqual(tm, { abc123: { fr: 'bonjour', de: 'hallo' } });
  });

  it('updateTranslationMemory merges with existing entry', () => {
    const tm = { abc123: { fr: 'bonjour' } };
    updateTranslationMemory(tm, 'abc123', { de: 'hallo' });
    assert.deepStrictEqual(tm, { abc123: { fr: 'bonjour', de: 'hallo' } });
  });

  it('load/save roundtrip preserves data', () => {
    const original = { [memoryKey('hello', 'greeting')]: { fr: 'bonjour', de: 'hallo', es: 'hola' } };
    saveTranslationMemory(tmPath, original);
    assert.deepStrictEqual(loadTranslationMemory(tmPath).memory, original);
  });
});
