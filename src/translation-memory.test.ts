import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
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
    const { memory, warnings } = loadTranslationMemory('/nonexistent/path.json');
    assert.deepStrictEqual(memory, {});
    assert.deepStrictEqual(warnings, []);
  });

  it('loadTranslationMemory loads existing translation memory', () => {
    const data = { [memoryKey('hello')]: { fr: 'bonjour', de: 'hallo' } };
    fs.writeFileSync(tmPath, JSON.stringify(data, null, 2));
    const { memory } = loadTranslationMemory(tmPath);
    assert.deepStrictEqual(memory, data);
  });

  it('loadTranslationMemory drops entries in the old key format and returns one warning with the path and count', () => {
    const kept = memoryKey('hello');
    fs.writeFileSync(
      tmPath,
      JSON.stringify({ [kept]: { fr: 'bonjour' }, '811c9dc5': { fr: 'old one' }, e8d4a2b1: { fr: 'old two' } }),
    );
    const realWrite = process.stderr.write;
    let wrote = false;
    process.stderr.write = (() => {
      wrote = true;
      return true;
    }) as typeof process.stderr.write;
    let loaded: ReturnType<typeof loadTranslationMemory>;
    try {
      loaded = loadTranslationMemory(tmPath);
    } finally {
      process.stderr.write = realWrite;
    }

    assert.deepStrictEqual(loaded.memory, { [kept]: { fr: 'bonjour' } });
    assert.strictEqual(loaded.warnings.length, 1, 'one warning, not one per entry');
    assert.ok(loaded.warnings[0].includes(tmPath) && loaded.warnings[0].includes('2'), loaded.warnings[0]);
    assert.strictEqual(wrote, false, 'loading is data in, data out: it prints nothing');
  });

  it('loadTranslationMemory returns no warning when every key is current', () => {
    fs.writeFileSync(tmPath, JSON.stringify({ [memoryKey('hello')]: { fr: 'bonjour' } }));

    assert.deepStrictEqual(loadTranslationMemory(tmPath).warnings, []);
  });

  it('memoryKey is 32 lowercase hex characters and stable', () => {
    assert.match(memoryKey('hello'), /^[0-9a-f]{32}$/);
    assert.strictEqual(memoryKey('hello'), memoryKey('hello'));
    assert.notStrictEqual(memoryKey('hello'), memoryKey('Hello'));
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
    assert.notStrictEqual(memoryKey(a), memoryKey(b));
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
    const original = { [memoryKey('hello')]: { fr: 'bonjour', de: 'hallo', es: 'hola' } };
    saveTranslationMemory(tmPath, original);
    const { memory } = loadTranslationMemory(tmPath);
    assert.deepStrictEqual(memory, original);
  });
});
