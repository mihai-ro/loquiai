import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LoquiError } from './errors.js';
import { hashValue } from './hasher.js';
import { translate } from './lib.js';
import { memoryKey } from './translation-memory.js';
import { translateJson } from './translator.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type LoquiConfig,
  type TranslationChunk,
  type TranslationResult,
} from './types.js';
import type { LogFn } from './utils/logger.js';

const config: LoquiConfig = { ...CONFIG_DEFAULTS };
const silent: LogFn = () => {};

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
      async translateChunk(chunk, targetLocales) {
        callCount++;
        return makeEngine().translateChunk(chunk, targetLocales, 'en', 'test');
      },
    };

    const source = { greeting: 'Hello' };
    const existing = { fr: { greeting: 'Bonjour' } };
    const hashStore = { greeting: hashValue('Hello') };

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
        async translateChunk(chunk, targetLocales) {
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

describe("translate — a target file holds exactly the source's keys", () => {
  function project(source: unknown, target: unknown): { dir: string; input: string; fr: string } {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    const fr = path.join(dir, 'fr.json');
    fs.writeFileSync(input, JSON.stringify(source), 'utf-8');
    fs.writeFileSync(fr, JSON.stringify(target), 'utf-8');
    return { dir, input, fr };
  }

  function countingEngine(): { engine: EngineAdapter; calls: () => number } {
    let calls = 0;
    const inner = makeEngine();
    return {
      engine: {
        async translateChunk(...args) {
          calls++;
          return inner.translateChunk(...args);
        },
      },
      calls: () => calls,
    };
  }

  /** What a run says through its logger, one message per line. */
  async function logOf(run: (logger: LogFn) => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    await run((_level, message) => {
      lines.push(message);
    });
    return lines.join('\n');
  }

  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

  test('a key restructured from an object to a string is translated once, then left alone', async () => {
    const { dir, input, fr } = project({ a: 'Hello' }, { a: { b: 'ancien' } });
    const { engine, calls } = countingEngine();
    const options = { input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine };

    await translate(options);
    assert.deepEqual(read(fr), { a: 'HELLO' });
    assert.equal(calls(), 1);

    await translate(options);
    assert.equal(calls(), 1, 'the second run has nothing to do');
  });

  test('an array that shrank loses its old tail', async () => {
    const { dir, input, fr } = project({ items: ['a', 'b'] }, { items: ['x', 'y', 'z'] });

    await translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine: makeEngine() });

    assert.deepEqual(read(fr), { items: ['x', 'y'] });
  });

  test('a key the source never had is removed, and the locale is told how many', async () => {
    const { dir, input, fr } = project({ a: 'Hello' }, { a: 'Bonjour', stale: 'x', old: { deep: 'y' } });

    const err = await logOf((logger) =>
      translate({
        input,
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        engine: makeEngine(),
        logger,
      }),
    );

    assert.deepEqual(read(fr), { a: 'Bonjour' });
    assert.match(err, /fr\W.*Removed 2 key\(s\)/);
    assert.match(err, /stale/);
    assert.match(err, /old\.deep/);
  });

  test('a dry run leaves the file byte-identical and says what it would remove', async () => {
    const { dir, input, fr } = project({ a: 'Hello' }, { a: 'Bonjour', stale: 'x' });
    const before = fs.readFileSync(fr, 'utf-8');

    const err = await logOf((logger) =>
      translate({
        input,
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        dryRun: true,
        engine: makeEngine(),
        logger,
      }),
    );

    assert.equal(fs.readFileSync(fr, 'utf-8'), before);
    assert.match(err, /Would remove 1 key\(s\)/);
    assert.match(err, /stale/);
  });

  test('a run with nothing to translate still writes the pruned file', async () => {
    const { dir, input, fr } = project({ a: 'Hello' }, { a: 'Bonjour', stale: 'x' });
    const { engine, calls } = countingEngine();

    await translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine });

    assert.equal(calls(), 0);
    assert.deepEqual(read(fr), { a: 'Bonjour' });
  });

  test('a target string at a key where the source holds a number is written as the number', async () => {
    const { dir, input, fr } = project({ count: 3 }, { count: 'trois' });

    await translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine: makeEngine() });

    assert.deepEqual(read(fr), { count: 3 });
  });

  test('a null in the target does not replace a string the source now defines', async () => {
    const { dir, input, fr } = project({ title: 'Hello' }, { title: null });

    await translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine: makeEngine() });

    assert.deepEqual(read(fr), { title: 'HELLO' });
  });
});

describe('translate — a blank target means not translated yet', () => {
  function project(source: unknown, target?: unknown): { dir: string; input: string; fr: string } {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    const fr = path.join(dir, 'fr.json');
    fs.writeFileSync(input, JSON.stringify(source), 'utf-8');
    if (target !== undefined) fs.writeFileSync(fr, JSON.stringify(target), 'utf-8');
    return { dir, input, fr };
  }

  /** Uppercases, but answers nothing for keys ending in a name from `refuse`; records what it was sent. */
  function engineRefusing(refuse: string[], sent: string[]): EngineAdapter {
    return {
      async translateChunk(chunk, targetLocales) {
        sent.push(...Object.keys(chunk.keys));
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            {
              keys: Object.fromEntries(
                Object.entries(chunk.keys)
                  .filter(([k]) => !refuse.some((r) => k.endsWith(r)))
                  .map(([k, v]) => [k, v.toUpperCase()]),
              ),
            },
          ]),
        );
      },
    };
  }

  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
  const run = (dir: string, input: string, engine: EngineAdapter, extra: Record<string, unknown> = {}) =>
    translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine, ...extra });

  test('a target file of empty strings is translated, not reported as up to date', async () => {
    const { dir, input, fr } = project({ title: 'Hello' }, { title: '' });
    const sent: string[] = [];

    await run(dir, input, engineRefusing([], sent));

    assert.deepEqual(sent, ['title']);
    assert.deepEqual(read(fr), { title: 'HELLO' });
  });

  for (const incremental of [false, true]) {
    test(`a refused array element is written as "" and is the only thing sent next time (incremental: ${incremental})`, async () => {
      const { dir, input, fr } = project({ items: ['a', 'b', 'c'] });
      const extra = incremental ? { incremental: true } : {};

      await run(dir, input, engineRefusing(['items.1'], []), extra);
      assert.deepEqual(read(fr), { items: ['A', '', 'C'] });

      const sent: string[] = [];
      await run(dir, input, engineRefusing([], sent), extra);
      assert.deepEqual(sent, ['items.1']);
      assert.deepEqual(read(fr), { items: ['A', 'B', 'C'] });
    });
  }

  test('a refused field of an object in an array is written as ""', async () => {
    const { dir, input, fr } = project({ steps: [{ title: 'T', body: 'B' }] });

    await run(dir, input, engineRefusing(['body'], []));

    assert.deepEqual(read(fr), { steps: [{ title: 'T', body: '' }] });
  });

  test('a refused key outside any array is absent from the file', async () => {
    const { dir, input, fr } = project({ a: 'x', b: 'y' });

    await run(dir, input, engineRefusing(['b'], []));

    assert.deepEqual(read(fr), { a: 'X' });
  });

  test('an engine answer of an empty string is still rejected', async () => {
    const { dir, input, fr } = project({ items: ['a', 'b'] });
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, k.endsWith('1') ? '' : 'DONE'])) },
          ]),
        );
      },
    };

    await run(dir, input, engine);

    assert.deepEqual(read(fr), { items: ['DONE', ''] });
  });
});

describe('translate — a corrupt file is an error, not an empty file', () => {
  const CONFLICT = '<<<<<<< HEAD\n{"a":"b"}\n=======\n{"a":"c"}\n>>>>>>> branch\n';

  function countingEngine(): { engine: EngineAdapter; calls: () => number } {
    let calls = 0;
    const inner = makeEngine();
    return {
      engine: {
        async translateChunk(...args) {
          calls++;
          return inner.translateChunk(...args);
        },
      },
      calls: () => calls,
    };
  }

  function project(): { dir: string; input: string } {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify({ greeting: 'Hello' }), 'utf-8');
    return { dir, input };
  }

  test('a target file with a merge-conflict marker fails with PARSE_ERROR and is left alone', async () => {
    const { dir, input } = project();
    const target = path.join(dir, 'fr.json');
    fs.writeFileSync(target, CONFLICT, 'utf-8');
    const { engine, calls } = countingEngine();

    await assert.rejects(
      translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine }),
      (err: unknown) => err instanceof LoquiError && err.code === 'PARSE_ERROR' && err.message.includes(target),
    );

    assert.equal(calls(), 0, 'nothing may be sent to a paid engine on top of a file we could not read');
    assert.equal(fs.readFileSync(target, 'utf-8'), CONFLICT);
  });

  test('a corrupt hash sidecar fails an incremental run instead of resetting change detection', async () => {
    const { dir, input } = project();
    const hashFile = path.join(dir, 'hashes.json');
    fs.writeFileSync(hashFile, CONFLICT, 'utf-8');
    const { engine, calls } = countingEngine();

    await assert.rejects(
      translate({ input, from: 'en', to: ['fr'], hashFile, engine }),
      (err: unknown) => err instanceof LoquiError && err.code === 'PARSE_ERROR' && err.message.includes(hashFile),
    );

    assert.equal(calls(), 0);
  });

  test('a corrupt hash sidecar the run does not use cannot fail it', async () => {
    const { dir, input } = project();
    fs.writeFileSync(path.join(dir, '.en.loqui-hash.json'), CONFLICT, 'utf-8');

    const result = await translate({ input, from: 'en', to: ['fr'], engine: makeEngine() });

    assert.equal(result.locales.fr.greeting, 'HELLO');
  });
});

describe('translate — a partial run keeps what it paid for', () => {
  // Long enough that each key lands in its own chunk at the minimum legal splitToken,
  // so one chunk can fail while the other succeeds.
  const KEEP = 'kept '.repeat(400);
  const BOOM = 'lost '.repeat(400);

  /** Fails only for the keys named, so a run can be made to half-succeed. */
  function flakyEngine(failOn: string[]): EngineAdapter {
    return {
      async translateChunk(chunk, targetLocales) {
        if (Object.keys(chunk.keys).some((k) => failOn.includes(k))) throw new Error('API exploded');
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = {
            keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, v.toUpperCase()])),
          };
        }
        return result;
      },
    };
  }

  test('writes the successful chunks and then reports CHUNK_FAILED', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify({ keep: KEEP, boom: BOOM }), 'utf-8');

    await assert.rejects(
      translate({
        input,
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        incremental: true,
        config: { splitToken: 500 },
        engine: flakyEngine(['boom']),
      }),
      (err: unknown) => err instanceof LoquiError && err.code === 'CHUNK_FAILED',
    );

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'fr.json'), 'utf-8'));
    assert.equal(written.keep, KEEP.toUpperCase(), 'the chunk that succeeded was paid for and must reach disk');
    assert.equal(written.boom, undefined);
  });

  describe('without an output path', () => {
    const input = JSON.stringify({ keep: KEEP, boom: BOOM });

    async function rejection(engine: EngineAdapter): Promise<LoquiError> {
      try {
        await translate({ input, from: 'en', to: ['fr'], config: { splitToken: 500 }, engine });
      } catch (err) {
        if (err instanceof LoquiError) return err;
        throw err;
      }
      assert.fail('translate() should have rejected');
    }

    test('hands the result back on the error', async () => {
      const err = await rejection(flakyEngine(['boom']));

      assert.equal(err.code, 'CHUNK_FAILED');
      assert.ok(err.result?.locales.fr, 'the paid-for chunk must be reachable when nothing is written');
      assert.equal(err.result.locales.fr.keep, KEEP.toUpperCase());
    });

    test('keeps the aggregate as the cause', async () => {
      const err = await rejection(flakyEngine(['boom']));

      assert.ok(err.cause instanceof AggregateError);
    });

    test('does not claim anything was written', async () => {
      const err = await rejection(flakyEngine(['boom']));

      assert.doesNotMatch(err.message, /was written/);
      assert.match(err.message, /nothing was saved/i);
    });

    test('carries a result with nothing in it when nothing landed, and keeps the engine error as it was', async () => {
      const err = await rejection({
        async translateChunk() {
          throw new LoquiError('AUTH', 'OpenAI API error 401: invalid key');
        },
      });

      assert.equal(err.code, 'AUTH');
      assert.equal(err.message, 'OpenAI API error 401: invalid key');
      assert.equal(err.result?.stats.keysTranslated, 0);
      assert.deepEqual(err.result?.written, {});
      assert.equal('partial' in err, false);
    });
  });

  describe('when every chunk fails the same way but translation memory served a key', () => {
    const authError = new LoquiError('AUTH', 'OpenAI API error 401: invalid key');
    const failing: EngineAdapter = {
      async translateChunk() {
        throw authError;
      },
    };

    async function rejection(withOutput: boolean): Promise<LoquiError> {
      const dir = nextTmp();
      fs.mkdirSync(dir, { recursive: true });
      const tmFile = path.join(dir, 'tm.json');
      fs.writeFileSync(tmFile, JSON.stringify({ [memoryKey('Hello')]: { fr: 'Bonjour' } }), 'utf-8');
      try {
        await translate({
          input: JSON.stringify({ served: 'Hello', sent: 'World' }),
          from: 'en',
          to: ['fr'],
          translationMemoryFile: tmFile,
          output: withOutput ? path.join(dir, '{locale}.json') : undefined,
          engine: failing,
        });
      } catch (err) {
        if (err instanceof LoquiError) return err;
        throw err;
      }
      assert.fail('translate() should have rejected');
    }

    for (const withOutput of [false, true]) {
      test(`keeps the engine's code and message and attaches what was served (output: ${withOutput})`, async () => {
        const err = await rejection(withOutput);

        assert.equal(err.code, 'AUTH');
        assert.equal(err.message, authError.message);
        assert.equal(err.cause, authError, 'the original error stays reachable');
        assert.ok(err.result?.locales.fr);
        assert.deepEqual(err.result.locales.fr, { served: 'Bonjour' });
      });
    }
  });

  test('a translation-memory entry in the old key format is warned about through the logger', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const tmFile = path.join(dir, 'tm.json');
    fs.writeFileSync(tmFile, JSON.stringify({ '811c9dc5': { fr: 'old' } }), 'utf-8');
    const warnings: string[] = [];

    await translate({
      input: JSON.stringify({ a: 'Hello' }),
      from: 'en',
      to: ['fr'],
      translationMemoryFile: tmFile,
      engine: makeEngine(),
      logger: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
    });

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(tmFile), warnings[0]);
  });

  test('says the output was written when there is an output path', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });

    await assert.rejects(
      translate({
        input: JSON.stringify({ keep: KEEP, boom: BOOM }),
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        config: { splitToken: 500 },
        engine: flakyEngine(['boom']),
      }),
      (err: unknown) =>
        err instanceof LoquiError && /written to disk/.test(err.message) && !/nothing was saved/i.test(err.message),
    );
  });

  test('the hash sidecar records only the keys that landed, so the next run retries the gap', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify({ keep: KEEP, boom: BOOM }), 'utf-8');
    const hashFile = path.join(dir, 'hashes.json');

    await assert.rejects(
      translate({
        input,
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        hashFile,
        config: { splitToken: 500 },
        engine: flakyEngine(['boom']),
      }),
      (err: unknown) => err instanceof LoquiError && err.code === 'CHUNK_FAILED',
    );

    const hashes = JSON.parse(fs.readFileSync(hashFile, 'utf-8'));
    assert.ok('keep' in hashes);
    assert.ok(!('boom' in hashes), 'recording a hash for an undelivered key would strand it');

    // second run: the engine is healthy now and picks up exactly what was missed
    const seen: string[] = [];
    await translate({
      input,
      from: 'en',
      to: ['fr'],
      output: path.join(dir, '{locale}.json'),
      hashFile,
      config: { splitToken: 500 },
      engine: {
        async translateChunk(chunk, targetLocales) {
          seen.push(...Object.keys(chunk.keys));
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

    assert.deepEqual(seen, ['boom'], 'only the key that failed should be retried');
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'fr.json'), 'utf-8'));
    assert.equal(written.boom, BOOM.toUpperCase());
    assert.equal(written.keep, KEEP.toUpperCase());
  });
});

describe('translate — the removed diff and validate modes', () => {
  for (const [flag, replacement] of [
    ['diff', 'diff()'],
    ['validate', 'validate()'],
  ] as const) {
    for (const value of [true, false]) {
      test(`${flag}: ${value} is rejected naming ${replacement}, before any file or engine is touched`, async () => {
        let engineCalls = 0;
        const engine: EngineAdapter = {
          async translateChunk() {
            engineCalls++;
            return {};
          },
        };

        await assert.rejects(
          // a v2 JavaScript caller: the file does not exist, so reading it first would fail differently
          translate({
            input: path.join(tmpDir, 'does-not-exist.json'),
            from: 'en',
            to: ['es'],
            engine,
            [flag]: value,
          } as never),
          (err: unknown) =>
            err instanceof LoquiError && err.code === 'INVALID_CONFIG' && err.message.includes(replacement),
        );

        assert.equal(engineCalls, 0);
      });
    }
  }

  test('an undefined flag is not a flag', async () => {
    const result = await translate({
      input: '{"a":"Hello"}',
      from: 'en',
      to: ['es'],
      engine: makeEngine(),
      diff: undefined,
      validate: undefined,
    } as never);

    assert.equal(result.locales.es.a, 'HELLO');
  });
});

describe('translate — a run that fails outright', () => {
  test('surfaces the underlying code when every chunk failed the same way', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify({ greeting: 'Hello' }), 'utf-8');

    await assert.rejects(
      translate({
        input,
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        engine: {
          async translateChunk() {
            throw new LoquiError('AUTH', 'OpenAI API error 401: invalid key');
          },
        },
      }),
      (err: unknown) => err instanceof LoquiError && err.code === 'AUTH',
    );
  });

  test('writes nothing when nothing was translated', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify({ greeting: 'Hello', retries: 3 }), 'utf-8');
    const hashFile = path.join(dir, 'hashes.json');

    await assert.rejects(
      translate({
        input,
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        hashFile,
        engine: {
          async translateChunk() {
            throw new LoquiError('AUTH', 'invalid key');
          },
        },
      }),
      (err: unknown) => err instanceof LoquiError && err.code === 'AUTH',
    );

    assert.ok(!fs.existsSync(path.join(dir, 'fr.json')), 'a locale file of only non-string values is not output');
    assert.ok(!fs.existsSync(hashFile), 'a run that did nothing must not rewrite the sidecar');
  });
});

describe('translate — the typed result', () => {
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

  test('resolves with documents as objects and written naming exactly the files that now exist', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify({ a: 'Hello', n: { b: 'World' } }), 'utf-8');

    const result = await translate({
      input,
      from: 'en',
      to: ['es', 'pt'],
      output: path.join(dir, '{locale}.json'),
      engine: makeEngine(),
    });

    assert.deepEqual(result.locales.es, { a: 'HELLO', n: { b: 'WORLD' } });
    assert.deepEqual(result.written, { es: path.join(dir, 'es.json'), pt: path.join(dir, 'pt.json') });
    for (const file of Object.values(result.written)) assert.ok(fs.existsSync(file));
    assert.deepEqual(read(result.written.es), result.locales.es);
    assert.equal(result.stats.keysTranslated, 4);
    assert.deepEqual(result.removed, { es: [], pt: [] });
  });

  test('written is empty on a dry run and when there is no output path', async () => {
    const dir = nextTmp();

    const dry = await translate({
      input: '{"a":"Hello"}',
      from: 'en',
      to: ['es'],
      output: path.join(dir, '{locale}.json'),
      dryRun: true,
      engine: makeEngine(),
    });
    const bare = await translate({ input: '{"a":"Hello"}', from: 'en', to: ['es'], engine: makeEngine() });

    assert.deepEqual(dry.written, {});
    assert.deepEqual(bare.written, {});
    assert.equal(fs.existsSync(dir), false);
  });

  test('removed names the keys pruned from an existing target', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'es.json'), JSON.stringify({ a: 'Hola', stale: 'x' }), 'utf-8');

    const result = await translate({
      input: '{"a":"Hello"}',
      from: 'en',
      to: ['es'],
      output: path.join(dir, '{locale}.json'),
      engine: makeEngine(),
    });

    assert.deepEqual(result.removed, { es: ['stale'] });
    assert.deepEqual(read(path.join(dir, 'es.json')), { a: 'Hola' });
  });

  test('an inline glossary key is not translated or written', async () => {
    const seen: string[] = [];
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        seen.push(...Object.keys(chunk.keys));
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            { keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, v])) },
          ]),
        );
      },
    };

    const result = await translate({
      input: JSON.stringify({ title: 'Open the Dashboard', glossary: { Dashboard: { es: 'Tablero' } } }),
      from: 'en',
      to: ['es'],
      config: { glossary: {} },
      engine,
    });

    assert.deepEqual(seen, ['title']);
    assert.equal('glossary' in result.locales.es, false);
  });
});

describe('translate — a failed run reports what was written', () => {
  const KEEP = 'kept '.repeat(400);
  const BOOM = 'lost '.repeat(400);

  function flaky(): EngineAdapter {
    const inner = makeEngine();
    return {
      async translateChunk(chunk, ...rest) {
        if ('boom' in chunk.keys) throw new Error('API exploded');
        return inner.translateChunk(chunk, ...rest);
      },
    };
  }

  async function rejection(promise: Promise<unknown>): Promise<LoquiError> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof LoquiError) return err;
      throw err;
    }
    assert.fail('translate() should have rejected');
  }

  test('result.written matches the files on disk, and there is no partial', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });

    const err = await rejection(
      translate({
        input: JSON.stringify({ keep: KEEP, boom: BOOM }),
        from: 'en',
        to: ['es', 'pt'],
        output: path.join(dir, '{locale}.json'),
        config: { splitToken: 500 },
        engine: flaky(),
      }),
    );

    assert.ok(err.result?.written);
    assert.deepEqual(Object.values(err.result.written).sort(), [path.join(dir, 'es.json'), path.join(dir, 'pt.json')]);
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      Object.values(err.result.written)
        .map((file) => path.basename(file))
        .sort(),
    );
    assert.equal(err.result.locales.es.keep, KEEP.toUpperCase());
    assert.equal('partial' in err, false);
    assert.match(err.message, /written to disk/);
  });

  test('result.written is empty when nothing landed, and nothing is on disk', async () => {
    const dir = nextTmp();

    const err = await rejection(
      translate({
        input: '{"a":"Hello"}',
        from: 'en',
        to: ['es'],
        output: path.join(dir, '{locale}.json'),
        engine: {
          async translateChunk() {
            throw new LoquiError('AUTH', 'OpenAI API error 401: invalid key');
          },
        },
      }),
    );

    assert.equal(err.code, 'AUTH');
    assert.deepEqual(err.result?.written, {});
    assert.equal(fs.existsSync(dir), false);
  });

  test('without an output path the message points at error.result', async () => {
    const err = await rejection(
      translate({
        input: JSON.stringify({ keep: KEEP, boom: BOOM }),
        from: 'en',
        to: ['es'],
        config: { splitToken: 500 },
        engine: flaky(),
      }),
    );

    assert.deepEqual(err.result?.written, {});
    assert.match(err.message, /nothing was saved/i);
    assert.match(err.message, /error\.result/);
  });

  test('an error that stops the run before anything is sent has no result', async () => {
    const err = await rejection(translate({ input: '{not json', from: 'en', to: ['es'], engine: makeEngine() }));

    assert.equal(err.code, 'PARSE_ERROR');
    assert.equal(err.result, undefined);
  });
});
