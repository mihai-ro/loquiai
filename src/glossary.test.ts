import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadGlossary, lookupGlossary, saveGlossary, updateGlossary } from './glossary.js';

describe('glossary', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-glossary-'));
  const glossaryPath = path.join(tmpDir, 'glossary.json');

  after(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('loadGlossary returns empty object when file does not exist', () => {
    const glossary = loadGlossary('/nonexistent/path.json');
    assert.deepStrictEqual(glossary, {});
  });

  it('loadGlossary loads existing glossary', () => {
    const data = { abc123: { fr: 'bonjour', de: 'hallo' } };
    fs.writeFileSync(glossaryPath, JSON.stringify(data, null, 2));
    const glossary = loadGlossary(glossaryPath);
    assert.deepStrictEqual(glossary, data);
  });

  it('saveGlossary writes to file', () => {
    const glossary = { abc123: { fr: 'bonjour' } };
    saveGlossary(glossaryPath, glossary);
    const content = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
    assert.deepStrictEqual(content, glossary);
  });

  it('lookupGlossary returns translations when all locales present', () => {
    const glossary = { abc123: { fr: 'bonjour', de: 'hallo' } };
    const result = lookupGlossary(glossary, 'abc123', ['fr', 'de']);
    assert.deepStrictEqual(result, { fr: 'bonjour', de: 'hallo' });
  });

  it('lookupGlossary returns null when locale missing', () => {
    const glossary = { abc123: { fr: 'bonjour' } };
    const result = lookupGlossary(glossary, 'abc123', ['fr', 'de']);
    assert.strictEqual(result, null);
  });

  it('lookupGlossary returns null when hash not found', () => {
    const glossary = { abc123: { fr: 'bonjour' } };
    const result = lookupGlossary(glossary, 'notfound', ['fr']);
    assert.strictEqual(result, null);
  });

  it('updateGlossary adds new entry', () => {
    const glossary: Record<string, Record<string, string>> = {};
    updateGlossary(glossary, 'abc123', { fr: 'bonjour', de: 'hallo' });
    assert.deepStrictEqual(glossary, { abc123: { fr: 'bonjour', de: 'hallo' } });
  });

  it('updateGlossary merges with existing entry', () => {
    const glossary = { abc123: { fr: 'bonjour' } };
    updateGlossary(glossary, 'abc123', { de: 'hallo' });
    assert.deepStrictEqual(glossary, { abc123: { fr: 'bonjour', de: 'hallo' } });
  });

  it('load/save roundtrip preserves data', () => {
    const original = { abc123: { fr: 'bonjour', de: 'hallo', es: 'hola' } };
    saveGlossary(glossaryPath, original);
    const loaded = loadGlossary(glossaryPath);
    assert.deepStrictEqual(loaded, original);
  });
});
