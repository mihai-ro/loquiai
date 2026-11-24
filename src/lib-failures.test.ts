import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LoquiError } from './errors.js';
import { translate } from './lib.js';
import { memoryKey } from './translation-memory.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type LoquiConfig,
  type TranslateChunkRequest,
  type TranslationResult,
} from './types.js';
import type { LogFn } from './utils/logger.js';

const _config: LoquiConfig = { ...CONFIG_DEFAULTS };
const _silent: LogFn = () => {};

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

/** The input file for a document: `translate()` and the CLI take paths only. */
function inputFile(json: string): string {
  const file = path.join(tmpDir, `input-${tmpCounter++}.json`);
  fs.writeFileSync(file, json);
  return file;
}

before(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loqui-test-'));
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('translate — a partial run keeps what it paid for', () => {
  // Long enough that each key lands in its own chunk at the minimum legal splitToken,
  // so one chunk can fail while the other succeeds.
  const KEEP = 'kept '.repeat(400);
  const BOOM = 'lost '.repeat(400);

  /** Fails only for the keys named, so a run can be made to half-succeed. */
  function flakyEngine(failOn: string[]): EngineAdapter {
    return {
      async translateChunk({ chunk, targetLocales }) {
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
        await translate({ input: inputFile(input), from: 'en', to: ['fr'], config: { splitToken: 500 }, engine });
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
      fs.writeFileSync(tmFile, JSON.stringify({ [memoryKey('Hello', 'served')]: { fr: 'Bonjour' } }), 'utf-8');
      try {
        await translate({
          input: inputFile(JSON.stringify({ served: 'Hello', sent: 'World' })),
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

  test('a translation-memory file with a v2 key is refused and left as it is', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const tmFile = path.join(dir, 'tm.json');
    fs.writeFileSync(tmFile, JSON.stringify({ '811c9dc5': { fr: 'old' } }), 'utf-8');
    const before = fs.readFileSync(tmFile, 'utf-8');

    await assert.rejects(
      translate({
        input: inputFile(JSON.stringify({ a: 'Hello' })),
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        translationMemoryFile: tmFile,
        engine: makeEngine(),
      }),
      (err: unknown) =>
        err instanceof LoquiError &&
        err.code === 'INVALID_CONFIG' &&
        err.message.includes(tmFile) &&
        err.message.includes('loqui migrate'),
    );

    assert.equal(fs.readFileSync(tmFile, 'utf-8'), before);
    assert.equal(fs.existsSync(path.join(dir, 'fr.json')), false);
  });

  test('says the output was written when there is an output path', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });

    await assert.rejects(
      translate({
        input: inputFile(JSON.stringify({ keep: KEEP, boom: BOOM })),
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

    const hashes = JSON.parse(fs.readFileSync(hashFile, 'utf-8')).fr;
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
        async translateChunk({ chunk, targetLocales }) {
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
      input: inputFile('{"a":"Hello"}'),
      from: 'en',
      to: ['es'],
      output: path.join(dir, '{locale}.json'),
      dryRun: true,
      engine: makeEngine(),
    });
    const bare = await translate({ input: inputFile('{"a":"Hello"}'), from: 'en', to: ['es'], engine: makeEngine() });

    assert.deepEqual(dry.written, {});
    assert.deepEqual(bare.written, {});
    assert.equal(fs.existsSync(dir), false);
  });

  test('removed names the keys pruned from an existing target', async () => {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'es.json'), JSON.stringify({ a: 'Hola', stale: 'x' }), 'utf-8');

    const result = await translate({
      input: inputFile('{"a":"Hello"}'),
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
      async translateChunk({ chunk, targetLocales }) {
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
      input: inputFile(JSON.stringify({ title: 'Open the Dashboard', glossary: { Dashboard: { es: 'Tablero' } } })),
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
      async translateChunk(req) {
        if ('boom' in req.chunk.keys) throw new Error('API exploded');
        return inner.translateChunk(req);
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
        input: inputFile(JSON.stringify({ keep: KEEP, boom: BOOM })),
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
        input: inputFile('{"a":"Hello"}'),
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
        input: inputFile(JSON.stringify({ keep: KEEP, boom: BOOM })),
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

  test('a JSON string is not an input: it is looked up as a path and not found', async () => {
    const err = await rejection(translate({ input: '{"a":"b"}', from: 'en', to: ['es'], engine: makeEngine() }));

    assert.equal(err.code, 'INPUT_NOT_FOUND');
  });

  test('an error that stops the run before anything is sent has no result', async () => {
    const err = await rejection(
      translate({ input: inputFile('{not json'), from: 'en', to: ['es'], engine: makeEngine() }),
    );

    assert.equal(err.code, 'PARSE_ERROR');
    assert.equal(err.result, undefined);
  });
});
