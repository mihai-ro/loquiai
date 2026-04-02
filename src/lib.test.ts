import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hashValue } from './hasher.js';
import { translate } from './lib.js';
import { translateJson } from './translator.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type LoquiConfig,
  type TranslationChunk,
  type TranslationResult,
} from './types.js';

const config: LoquiConfig = { ...CONFIG_DEFAULTS };

let tmpDir: string;
let tmpCounter = 0;

function makeEngine(transform: (v: string) => string = (v) => v.toUpperCase()): EngineAdapter {
  return {
    async translateChunk(chunk: TranslationChunk, targetLocales: string[]): Promise<Record<string, TranslationResult>> {
      const result: Record<string, TranslationResult> = {};
      for (const locale of targetLocales) {
        const keys: Record<string, string> = {};
        for (const [k, v] of Object.entries(chunk.keys)) {
          keys[k] = transform(v);
        }
        result[locale] = { keys };
      }
      return result;
    },
  };
}

function nextTmp(): string {
  return path.join(tmpDir, `test-${tmpCounter++}`);
}

before(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loqui-test-'));
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('translate — basic functionality', () => {
  test('returns a locale map with correct keys and valid JSON', async () => {
    const result = await translate({
      input: '{"greeting":"hello","farewell":"goodbye"}',
      from: 'en',
      to: ['fr', 'de'],
      engine: makeEngine(),
    });

    assert.ok(result.fr);
    assert.ok(result.de);

    const fr = JSON.parse(result.fr);
    assert.equal(fr.greeting, 'HELLO');
    assert.equal(fr.farewell, 'GOODBYE');

    const de = JSON.parse(result.de);
    assert.equal(de.greeting, 'HELLO');
  });

  test('throws on invalid JSON input', async () => {
    await assert.rejects(
      () =>
        translate({
          input: '{"greeting": invalid}',
          from: 'en',
          to: ['fr'],
        }),
      (err: Error) => err.message.includes('Failed to parse input as JSON'),
    );
  });

  test('throws when from locale is missing', async () => {
    await assert.rejects(
      () =>
        translate({
          input: '{"greeting":"hello"}',
          to: ['fr'],
        }),
      (err: Error) => err.message.includes("'from'") || err.message.includes('source locale'),
    );
  });

  test('throws when to locales are missing', async () => {
    await assert.rejects(
      () =>
        translate({
          input: '{"greeting":"hello"}',
          from: 'en',
        }),
      (err: Error) => err.message.includes("'to'") || err.message.includes('target locale'),
    );
  });
});

describe('translate — dry-run mode', () => {
  test('does not write files to disk when dryRun is true', async () => {
    const dir = nextTmp();
    const outPath = path.join(dir, '{locale}.json');

    await translate({
      input: '{"greeting":"hello"}',
      from: 'en',
      to: ['fr'],
      output: outPath,
      dryRun: true,
      engine: makeEngine(),
    });

    assert.equal(fs.existsSync(path.join(dir, 'fr.json')), false, 'file should not be written in dry-run mode');
  });

  test('does not write hash file in dry-run mode', async () => {
    const dir = nextTmp();
    await fs.promises.mkdir(dir, { recursive: true });
    const inputPath = path.join(dir, 'en.json');
    await fs.promises.writeFile(inputPath, '{"greeting":"hello"}');
    const hashFile = path.join(dir, 'en.loqui-hash.json');

    await translate({
      input: inputPath,
      from: 'en',
      to: ['fr'],
      incremental: true,
      hashFile,
      dryRun: true,
      engine: makeEngine(),
    });

    assert.equal(fs.existsSync(hashFile), false, 'hash file should not be written in dry-run mode');
  });
});

describe('translate — force mode', () => {
  test('re-translates all keys regardless of existing translations', async () => {
    const result = await translateJson({
      sourceFlat: { greeting: 'hello' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: { greeting: 'Bonjour' } },
      force: true,
      engine: makeEngine(),
    });

    assert.equal(result.translations.fr.greeting, 'HELLO');
  });
});

describe('translate — output path template', () => {
  test('substitutes {locale} in output path', async () => {
    const dir = nextTmp();
    const outPath = path.join(dir, '{locale}.json');

    await translate({
      input: '{"greeting":"hello"}',
      from: 'en',
      to: ['fr', 'de'],
      output: outPath,
      engine: makeEngine(),
    });

    const frPath = path.join(dir, 'fr.json');
    const dePath = path.join(dir, 'de.json');

    assert.equal(fs.existsSync(frPath), true, 'fr.json should be created');
    assert.equal(fs.existsSync(dePath), true, 'de.json should be created');

    const fr = JSON.parse(await fs.promises.readFile(frPath, 'utf-8'));
    assert.equal(fr.greeting, 'HELLO');
  });

  test('treats plain directory path as output dir', async () => {
    const dir = nextTmp();

    await translate({
      input: '{"greeting":"hello"}',
      from: 'en',
      to: ['fr'],
      output: dir,
      engine: makeEngine(),
    });

    const frPath = path.join(dir, 'fr.json');
    assert.equal(fs.existsSync(frPath), true, 'fr.json should be written to directory');
  });

  test('accepts explicit Record<string,string> output', async () => {
    const dir = nextTmp();
    const explicitOutput: Record<string, string> = {
      fr: path.join(dir, 'french.json'),
      de: path.join(dir, 'german.json'),
    };

    await translate({
      input: '{"greeting":"hello"}',
      from: 'en',
      to: ['fr', 'de'],
      output: explicitOutput,
      engine: makeEngine(),
    });

    assert.equal(fs.existsSync(path.join(dir, 'french.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'german.json')), true);
  });
});

describe('translate — incremental mode', () => {
  test('skips engine call for unchanged keys', async () => {
    let callCount = 0;
    const countingEngine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        callCount++;
        return makeEngine().translateChunk(chunk, targetLocales, 'en', 'test');
      },
    };

    const source = { greeting: 'Hello' };
    const existing = { fr: { greeting: 'Bonjour' } };
    const hashStore = { greeting: hashValue('Hello') };

    await translateJson({
      sourceFlat: source,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing,
      hashStore,
      engine: countingEngine,
    });

    assert.equal(callCount, 0, 'engine should not be called when hashes match');
  });

  test('re-translates only changed keys when hash is stale', async () => {
    const source = { greeting: 'Hello!', farewell: 'Goodbye' };
    const existing = { fr: { greeting: 'Bonjour', farewell: 'Au revoir' } };
    const hashStore = {
      greeting: hashValue('Hello!'), // matches
      farewell: hashValue('Old value'), // stale
    };

    let capturedChunkKeys: Record<string, string> = {};
    const trackingEngine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        capturedChunkKeys = { ...chunk.keys };
        return makeEngine().translateChunk(chunk, targetLocales, 'en', 'test');
      },
    };

    await translateJson({
      sourceFlat: source,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing,
      hashStore,
      engine: trackingEngine,
    });

    assert.ok(capturedChunkKeys.farewell !== undefined, 'stale key should be re-translated');
    assert.equal(capturedChunkKeys.greeting, undefined, 'unchanged key should not be sent to engine');
  });
});
