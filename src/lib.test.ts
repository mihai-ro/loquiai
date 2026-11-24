import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LoquiError } from './errors.js';
import { hashValue } from './hasher.js';
import { translate } from './lib.js';
import { translateJson } from './translator.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type LoquiConfig,
  type TranslateChunkRequest,
  type TranslationResult,
} from './types.js';
import type { LogFn } from './utils/logger.js';

const config: LoquiConfig = { ...CONFIG_DEFAULTS };
const silent: LogFn = () => {};

let tmpDir: string;
let tmpCounter = 0;

function makeEngine(transform: (v: string) => string = (v) => v.toUpperCase()): EngineAdapter {
  return {
    async translateChunk({ chunk, targetLocales }: TranslateChunkRequest): Promise<Record<string, TranslationResult>> {
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
  test('returns one document per locale with the translated keys', async () => {
    const result = await translate({
      input: '{"greeting":"hello","farewell":"goodbye"}',
      from: 'en',
      to: ['fr', 'de'],
      engine: makeEngine(),
    });

    const { fr, de } = result.locales;
    assert.equal(fr.greeting, 'HELLO');
    assert.equal(fr.farewell, 'GOODBYE');
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

  test('throws on a __proto__ target locale', async () => {
    await assert.rejects(
      () => translate({ input: '{"greeting":"hello"}', from: 'en', to: '__proto__', engine: makeEngine() }),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_CONFIG',
    );
  });

  test('rejects a missing input file with INPUT_NOT_FOUND, naming the path', async () => {
    const missing = path.join(nextTmp(), 'nope.json');
    await assert.rejects(
      () => translate({ input: missing, from: 'en', to: 'fr', engine: makeEngine() }),
      (err: unknown) => err instanceof LoquiError && err.code === 'INPUT_NOT_FOUND' && err.message.includes(missing),
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
      logger: silent,
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

describe('translate — glossary', () => {
  test('glossary key is preserved when glossary feature is disabled', async () => {
    // A namespace legitimately named "glossary" must not be stripped when the feature is off
    const source = JSON.stringify({ title: 'hello', glossary: { search: 'Search' } });
    const result = await translate({
      input: source,
      from: 'en',
      to: ['es'],
      config: { ...CONFIG_DEFAULTS },
      engine: makeEngine(),
    });
    const es = result.locales.es;
    assert.ok('glossary' in es, 'glossary key must not be stripped when feature is disabled');
  });

  test('inline glossary key in source is stripped and not translated', async () => {
    // Source has a top-level "glossary" key — it must be stripped before translation
    // and must not appear in any output locale
    const sourceWithGlossary = JSON.stringify({
      greeting: 'hello',
      glossary: { Dashboard: { es: 'Tablero' } },
    });

    const result = await translate({
      input: sourceWithGlossary,
      from: 'en',
      to: ['es'],
      config: { ...CONFIG_DEFAULTS, glossary: {} },
      engine: makeEngine(),
    });

    const es = result.locales.es;
    assert.ok('greeting' in es, 'greeting key must be present');
    assert.ok(!('glossary' in es), 'glossary key must be stripped from output');
  });

  test('noTranslate terms in glossary config survive translation verbatim', async () => {
    // Engine uppercases everything — but noTranslate terms must survive as-is
    const result = await translate({
      input: JSON.stringify({ title: 'Welcome to Loqui today' }),
      from: 'en',
      to: ['es'],
      config: { ...CONFIG_DEFAULTS, glossary: { noTranslate: ['Loqui'] } },
      engine: makeEngine(),
    });

    const es = result.locales.es;
    assert.ok(String(es.title).includes('Loqui'), 'Loqui must survive translation verbatim');
  });

  test('rejects invalid inline glossary config before translating', async () => {
    // loadConfig only validates the file; the inline merge must be re-validated too.
    await assert.rejects(
      () =>
        translate({
          input: JSON.stringify({ title: 'hello' }),
          from: 'en',
          to: ['es'],
          config: { ...CONFIG_DEFAULTS, glossary: { noTranslate: ['ok', 7] } as never },
          engine: makeEngine(),
        }),
      (err: Error) => err.message.includes("'glossary.noTranslate' must be an array of strings"),
    );
  });

  test('rejects inline glossary with empty path', async () => {
    await assert.rejects(
      () =>
        translate({
          input: JSON.stringify({ title: 'hello' }),
          from: 'en',
          to: ['es'],
          config: { ...CONFIG_DEFAULTS, glossary: { path: '  ' } },
          engine: makeEngine(),
        }),
      (err: Error) => err.message.includes("'glossary.path' must be a non-empty string"),
    );
  });
});

describe('translate — incremental mode', () => {
  test('skips engine call for unchanged keys', async () => {
    let callCount = 0;
    const countingEngine: EngineAdapter = {
      async translateChunk(req) {
        callCount++;
        return makeEngine().translateChunk(req);
      },
    };

    const source = { greeting: 'Hello' };
    const existing = { fr: { greeting: 'Bonjour' } };
    const hashStore = { fr: { greeting: hashValue('Hello') } };

    await translateJson({
      logger: silent,
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
      fr: {
        greeting: hashValue('Hello!'), // matches
        farewell: hashValue('Old value'), // stale
      },
    };

    let capturedChunkKeys: Record<string, string> = {};
    const trackingEngine: EngineAdapter = {
      async translateChunk(req) {
        capturedChunkKeys = { ...req.chunk.keys };
        return makeEngine().translateChunk(req);
      },
    };

    await translateJson({
      logger: silent,
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

describe('translate — non-string values survive the round trip', () => {
  const mixed = {
    label: 'Hello',
    items: ['alpha', 'beta'],
    count: 42,
    ratio: 0.5,
    enabled: false,
    missing: null,
    empty: [],
    blank: {},
    version: '42',
    nested: { deep: { list: [1, 'two', true, null] } },
  };

  test('arrays, numbers, booleans and null reach the output file unchanged', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify(mixed), 'utf-8');

    await translate({
      input,
      from: 'en',
      to: ['fr'],
      output: path.join(dir, '{locale}.json'),
      engine: makeEngine(),
    });

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'fr.json'), 'utf-8'));

    assert.deepEqual(written.items, ['ALPHA', 'BETA'], 'arrays stay arrays, element by element');
    assert.equal(written.count, 42);
    assert.equal(typeof written.count, 'number');
    assert.equal(written.ratio, 0.5);
    assert.equal(written.enabled, false);
    assert.ok('missing' in written, 'a null value must not lose its key');
    assert.equal(written.missing, null);
    assert.deepEqual(written.empty, []);
    assert.deepEqual(written.blank, {});
    assert.equal(written.version, '42', 'a numeric-looking string stays a string');
    assert.equal(typeof written.version, 'string');
    assert.deepEqual(written.nested.deep.list, [1, 'TWO', true, null]);
  });

  test('only strings are sent to the engine', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify(mixed), 'utf-8');

    const seen: string[] = [];
    await translate({
      input,
      from: 'en',
      to: ['fr'],
      output: path.join(dir, '{locale}.json'),
      engine: {
        async translateChunk({ chunk, targetLocales }) {
          seen.push(...Object.values(chunk.keys));
          const result: Record<string, TranslationResult> = {};
          for (const locale of targetLocales) {
            result[locale] = {
              keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, v.toUpperCase()])),
            };
          }
          return result;
        },
      },
    });

    assert.deepEqual(seen.sort(), ['Hello', 'alpha', 'beta', 'two', '42'].sort());
  });

  test('writing over the source file preserves its structure', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify(mixed), 'utf-8');

    await translate({
      input,
      from: 'en',
      to: ['en'],
      output: path.join(dir, '{locale}.json'),
      force: true,
      engine: makeEngine(),
    });

    const rewritten = JSON.parse(fs.readFileSync(input, 'utf-8'));

    assert.deepEqual(rewritten.items, ['ALPHA', 'BETA']);
    assert.equal(rewritten.count, 42);
    assert.equal(rewritten.missing, null);
    assert.deepEqual(rewritten.empty, []);
  });
});
