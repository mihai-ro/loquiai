import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  loadTranslationMemory,
  lookupTranslationMemory,
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
    const tm = loadTranslationMemory('/nonexistent/path.json');
    assert.deepStrictEqual(tm, {});
  });

  it('loadTranslationMemory loads existing translation memory', () => {
    const data = { abc123: { fr: 'bonjour', de: 'hallo' } };
    fs.writeFileSync(tmPath, JSON.stringify(data, null, 2));
    const tm = loadTranslationMemory(tmPath);
    assert.deepStrictEqual(tm, data);
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

  it('lookupTranslationMemory returns null when locale missing', () => {
    const tm = { abc123: { fr: 'bonjour' } };
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
    const original = { abc123: { fr: 'bonjour', de: 'hallo', es: 'hola' } };
    saveTranslationMemory(tmPath, original);
    const loaded = loadTranslationMemory(tmPath);
    assert.deepStrictEqual(loaded, original);
  });
});
