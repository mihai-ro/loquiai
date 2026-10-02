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
    const es = JSON.parse(result.es);
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

    const es = JSON.parse(result.es);
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

    const es = JSON.parse(result.es);
    assert.ok(es.title?.includes('Loqui'), 'Loqui must survive translation verbatim');
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

  test('a corrupt hash sidecar fails --diff, which reads it', async () => {
    const { dir, input } = project();
    fs.writeFileSync(path.join(dir, '.en.loqui-hash.json'), CONFLICT, 'utf-8');

    await assert.rejects(
      translate({ input, from: 'en', to: ['fr'], diff: true }),
      (err: unknown) => err instanceof LoquiError && err.code === 'PARSE_ERROR',
    );
  });

  test('a corrupt hash sidecar the run does not use cannot fail it', async () => {
    const { dir, input } = project();
    fs.writeFileSync(path.join(dir, '.en.loqui-hash.json'), CONFLICT, 'utf-8');

    const result = await translate({ input, from: 'en', to: ['fr'], engine: makeEngine() });

    assert.equal(JSON.parse(result.fr).greeting, 'HELLO');
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

    test('hands the partial result back on the error', async () => {
      const err = await rejection(flakyEngine(['boom']));

      assert.equal(err.code, 'CHUNK_FAILED');
      assert.ok(err.partial?.fr, 'the paid-for chunk must be reachable when nothing is written');
      assert.equal(JSON.parse(err.partial.fr).keep, KEEP.toUpperCase());
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

    test('carries no partial when nothing landed, and keeps the engine error as it was', async () => {
      const err = await rejection({
        async translateChunk() {
          throw new LoquiError('AUTH', 'OpenAI API error 401: invalid key');
        },
      });

      assert.equal(err.code, 'AUTH');
      assert.equal(err.message, 'OpenAI API error 401: invalid key');
      assert.equal(err.partial, undefined);
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
        assert.ok(err.partial?.fr);
        assert.deepEqual(JSON.parse(err.partial.fr), { served: 'Bonjour' });
      });
    }
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

describe('translate — diff mode', () => {
  test('a correctly translated key is not reported as changed', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify({ greeting: 'Hello' }), 'utf-8');
    fs.writeFileSync(path.join(dir, 'fr.json'), JSON.stringify({ greeting: 'Bonjour' }), 'utf-8');
    const hashFile = path.join(dir, 'hashes.json');
    fs.writeFileSync(hashFile, JSON.stringify({ greeting: hashValue('Hello') }), 'utf-8');

    // diff writes its report to stderr and returns an empty map
    const result = await translate({
      input,
      from: 'en',
      to: ['fr'],
      output: path.join(dir, '{locale}.json'),
      hashFile,
      diff: true,
    });

    assert.deepEqual(result, {});
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
