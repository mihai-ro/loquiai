import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { translate } from './lib.js';
import { memoryKey } from './translation-memory.js';
import type { EngineAdapter, TranslateChunkRequest, TranslationResult } from './types.js';

let tmpDir: string;
let counter = 0;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-prune-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const engine: EngineAdapter = {
  async translateChunk({ chunk, targetLocales }: TranslateChunkRequest): Promise<Record<string, TranslationResult>> {
    return Object.fromEntries(
      targetLocales.map((locale) => [
        locale,
        { keys: Object.fromEntries(Object.entries(chunk.keys).map(([key, value]) => [key, value.toUpperCase()])) },
      ]),
    );
  },
};

/** A directory with one memory file that several inputs can share. */
function workspace() {
  const dir = path.join(tmpDir, `w${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const memoryFile = path.join(dir, 'tm.json');
  const write = (name: string, doc: Record<string, string>) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(doc));
    return file;
  };
  const run = (input: string, extra: { dryRun?: boolean } = {}) =>
    translate({
      input,
      from: 'en',
      to: ['es'],
      output: path.join(dir, `${path.basename(input, '.json')}-{locale}.json`),
      translationMemoryFile: memoryFile,
      engine,
      ...extra,
    });
  const memory = (): Record<string, unknown> => JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
  const entries = () => Object.keys(memory()).filter((key) => !key.startsWith('$'));
  return { dir, memoryFile, write, run, memory, entries };
}

describe('translation memory pruning', () => {
  test('an entry whose key left the source is gone after the next run', async () => {
    const w = workspace();
    const input = w.write('a.json', { one: 'One', two: 'Two' });
    await w.run(input);
    assert.deepEqual(w.entries().sort(), [memoryKey('One', 'one', 'en'), memoryKey('Two', 'two', 'en')].sort());

    w.write('a.json', { one: 'One' });
    await w.run(input);

    assert.deepEqual(w.entries(), [memoryKey('One', 'one', 'en')]);
  });

  test('a shared memory file keeps the other input’s entries', async () => {
    const w = workspace();
    const a = w.write('a.json', { one: 'One', two: 'Two' });
    const b = w.write('b.json', { other: 'Other' });
    await w.run(a);
    await w.run(b);

    w.write('a.json', { one: 'One' });
    await w.run(a);

    assert.deepEqual(w.entries().sort(), [memoryKey('One', 'one', 'en'), memoryKey('Other', 'other', 'en')].sort());
  });

  test('an entry another input still lists survives the input that dropped it', async () => {
    const w = workspace();
    const a = w.write('a.json', { save: 'Save' });
    const b = w.write('b.json', { save: 'Save' });
    await w.run(a);
    await w.run(b);

    w.write('a.json', { other: 'Other' });
    await w.run(a);

    assert.ok(w.entries().includes(memoryKey('Save', 'save', 'en')), 'b still yields it');
    assert.ok(w.entries().includes(memoryKey('Other', 'other', 'en')), 'and a holds the new one');
  });

  test('a dry run prunes nothing', async () => {
    const w = workspace();
    const input = w.write('a.json', { one: 'One', two: 'Two' });
    await w.run(input);
    const before = fs.readFileSync(w.memoryFile, 'utf-8');

    w.write('a.json', { one: 'One' });
    await w.run(input, { dryRun: true });

    assert.equal(fs.readFileSync(w.memoryFile, 'utf-8'), before);
  });

  test('entries nobody lists, from a file that predates owners, are kept', async () => {
    const w = workspace();
    const legacy = memoryKey('Legacy', 'gone', 'en');
    fs.writeFileSync(w.memoryFile, JSON.stringify({ [legacy]: { es: 'Antiguo' } }));
    const input = w.write('a.json', { one: 'One' });

    await w.run(input);

    assert.ok(w.entries().includes(legacy));
    assert.deepEqual(w.memory().$owners, { 'a.json': [memoryKey('One', 'one', 'en')] });
  });
});
