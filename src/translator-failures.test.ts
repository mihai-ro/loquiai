import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LoquiError } from './errors.js';
import { hashValue } from './hasher.js';
import { translateJson } from './translator.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type LoquiConfig,
  type RunWarning,
  type TranslateChunkRequest,
  type TranslationResult,
} from './types.js';
import type { LogFn } from './utils/logger.js';

const config: LoquiConfig = { ...CONFIG_DEFAULTS };
const silent: LogFn = () => {};

/** Engine that uppercases every value — deterministic, no network calls. */
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

describe('translateJson — chunk failure handling', () => {
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

  test('reports the failure in stats instead of discarding the run', async () => {
    const engine: EngineAdapter = {
      async translateChunk() {
        throw new Error('API exploded');
      },
    };

    const { stats } = await translateJson({
      logger: silent,
      sourceFlat: { hello: 'world' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine,
    });

    assert.equal(stats.failedChunks, 1);
    assert.ok(stats.warnings.some((w) => w.message.includes('API exploded')));
  });

  test('keeps the output of the chunks that succeeded', async () => {
    // splitToken of 1 forces one key per chunk, so one can fail alone
    const sourceFlat = { keep: 'kept', boom: 'lost' };
    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, splitToken: 1 },
      engine: flakyEngine(['boom']),
    });

    assert.equal(stats.failedChunks, 1);
    assert.equal(translations.fr.keep, 'KEPT', 'a paid-for chunk must not be thrown away');
    assert.equal(translations.fr.boom, undefined);
  });

  test('records hashes only for keys that reached every locale', async () => {
    const sourceFlat = { keep: 'kept', boom: 'lost' };
    const { updatedHashStore } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, splitToken: 1 },
      engine: flakyEngine(['boom']),
    });

    assert.equal(updatedHashStore.fr.keep, hashValue('kept'));
    assert.ok(!('boom' in updatedHashStore.fr), 'a hash for an undelivered key would make the next run skip it');
  });

  test('a key missing from one locale is not recorded as done', async () => {
    // fr succeeds, de is dropped by the engine entirely
    const engine: EngineAdapter = {
      async translateChunk({ chunk }) {
        return {
          fr: { keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, v.toUpperCase()])) },
        };
      },
    };

    const { updatedHashStore } = await translateJson({
      logger: silent,
      sourceFlat: { hello: 'world' },
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      engine,
    });

    assert.ok('hello' in updatedHashStore.fr, 'fr received it');
    assert.ok(!('hello' in updatedHashStore.de), 'de never did, so it still owes the key');
  });
});

describe('translateJson — fail fast on a bad key', () => {
  // each value is long enough to fill a chunk on its own at the smallest legal splitToken
  const LONG = 'x'.repeat(2000);
  const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, `${LONG}${i}`]));
  const oneKeyPerChunk = { ...config, splitToken: 500, concurrency: 8 };

  test('an engine that rejects every call with AUTH is called at most once per worker', async () => {
    let calls = 0;
    const engine: EngineAdapter = {
      async translateChunk() {
        calls++;
        throw new LoquiError('AUTH', 'invalid key');
      },
    };

    const { failure } = await translateJson({
      logger: silent,
      sourceFlat: fifty,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: oneKeyPerChunk,
      engine,
    });

    assert.ok(calls <= 8, `${calls} calls for 50 chunks at concurrency 8`);
    assert.equal(failure?.code, 'AUTH');
  });

  test('a failure that is not AUTH does not stop the other chunks', async () => {
    let calls = 0;
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        calls++;
        if ('k0' in chunk.keys) throw new Error('API exploded');
        return Object.fromEntries(targetLocales.map((l) => [l, { keys: { ...chunk.keys } }]));
      },
    };

    const { stats } = await translateJson({
      logger: silent,
      sourceFlat: fifty,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: oneKeyPerChunk,
      engine,
    });

    assert.equal(calls, 50);
    assert.equal(stats.failedChunks, 1);
  });

  test('an AUTH failure after some chunks landed still reports AUTH and keeps what landed', async () => {
    let calls = 0;
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        calls++;
        if (calls > 1) throw new LoquiError('AUTH', 'key revoked');
        return Object.fromEntries(
          targetLocales.map((l) => [l, { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'DONE'])) }]),
        );
      },
    };

    const { failure, translations } = await translateJson({
      logger: silent,
      sourceFlat: fifty,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...oneKeyPerChunk, concurrency: 1 },
      engine,
    });

    assert.equal(calls, 2, 'nothing starts after the AUTH rejection');
    assert.equal(failure?.code, 'AUTH');
    assert.equal(translations.fr.k0, 'DONE');
  });
});

describe('translateJson — a truncated chunk is split', () => {
  const four = { k0: 'Zero', k1: 'One', k2: 'Two', k3: 'Three' };
  const truncated = () => new LoquiError('TRUNCATED', 'cut off at the output token limit');

  /** Truncates any call over `limit` keys; otherwise uppercases. */
  function limitedEngine(limit: number, calls: string[][] = []): EngineAdapter {
    return {
      async translateChunk({ chunk, targetLocales }) {
        const keys = Object.keys(chunk.keys);
        calls.push(keys);
        if (keys.length > limit) throw truncated();
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            { keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, v.toUpperCase()])) },
          ]),
        );
      },
    };
  }

  test('a chunk the engine cuts off ends with every key translated', async () => {
    const calls: string[][] = [];

    const { translations, failure } = await translateJson({
      logger: silent,
      sourceFlat: four,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: limitedEngine(2, calls),
    });

    assert.equal(failure, undefined);
    assert.deepEqual(translations.fr, { k0: 'ZERO', k1: 'ONE', k2: 'TWO', k3: 'THREE' });
    assert.deepEqual(calls, [
      ['k0', 'k1', 'k2', 'k3'],
      ['k0', 'k1'],
      ['k2', 'k3'],
    ]);
  });

  test('halves are split again until they fit', async () => {
    const calls: string[][] = [];

    const { translations, failure } = await translateJson({
      logger: silent,
      sourceFlat: four,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: limitedEngine(1, calls),
    });

    assert.equal(failure, undefined);
    assert.equal(Object.keys(translations.fr).length, 4);
    assert.ok(calls.every((c) => c.length <= 2 || c.length === 4));
  });

  test('a single key that is cut off fails with TRUNCATED', async () => {
    const { failure, translations } = await translateJson({
      logger: silent,
      sourceFlat: { only: 'One value' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: limitedEngine(0),
    });

    assert.equal(failure?.code, 'TRUNCATED');
    assert.equal(translations.fr.only, undefined);
  });

  test('what one half delivered stays delivered when the other half fails', async () => {
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        const keys = Object.keys(chunk.keys);
        if (keys.length > 2) throw truncated();
        if (keys.includes('k3')) throw new Error('API exploded');
        return Object.fromEntries(
          targetLocales.map((l) => [l, { keys: Object.fromEntries(keys.map((k) => [k, 'DONE'])) }]),
        );
      },
    };

    const { translations, failure } = await translateJson({
      logger: silent,
      sourceFlat: four,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine,
    });

    assert.equal(translations.fr.k0, 'DONE');
    assert.equal(translations.fr.k1, 'DONE');
    assert.equal(translations.fr.k3, undefined);
    assert.equal(failure?.code, 'CHUNK_FAILED');
  });

  test('when both halves fail, neither error is lost', async () => {
    const engine: EngineAdapter = {
      async translateChunk({ chunk }) {
        const keys = Object.keys(chunk.keys);
        if (keys.length > 2) throw truncated();
        throw new Error(`exploded on ${keys.join('+')}`);
      },
    };

    const { stats } = await translateJson({
      logger: silent,
      sourceFlat: four,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine,
    });

    assert.ok(stats.warnings.some((w) => w.message.includes('exploded on k0+k1')));
    assert.ok(
      stats.warnings.some((w) => w.message.includes('exploded on k2+k3')),
      'the second half failed too',
    );
  });

  describe('the cost of splitting', () => {
    // two keys per chunk at splitToken 500; an engine that fits one key per call splits every chunk
    const wide = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`w${i}`, `${'word '.repeat(80)}${i}`]));
    const splitNotes = (warnings: RunWarning[]) => warnings.filter((w) => /re-sent in halves/.test(w.message));

    test('is reported once per run, however many chunks split', async () => {
      const { stats } = await translateJson({
        logger: silent,
        sourceFlat: wide,
        from: 'en',
        to: ['fr'],
        namespace: 'test',
        config: { ...config, splitToken: 500 },
        engine: limitedEngine(1),
      });

      assert.equal(splitNotes(stats.warnings).length, 1);
      assert.ok(splitNotes(stats.warnings)[0].message.includes('splitToken'), 'the warning names what avoids the cost');
      assert.equal(splitNotes(stats.warnings)[0].code, 'CUT_OFF');
    });

    test('is not reported when nothing was cut off', async () => {
      const { stats } = await translateJson({
        logger: silent,
        sourceFlat: four,
        from: 'en',
        to: ['fr'],
        namespace: 'test',
        config,
        engine: limitedEngine(10),
      });

      assert.equal(splitNotes(stats.warnings).length, 0);
    });
  });

  test('a value skipped by ICU masking is warned about once, however often the chunk splits', async () => {
    const { stats } = await translateJson({
      logger: silent,
      sourceFlat: { ...four, bad: '{n, plural, one {# item} other {# items' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: limitedEngine(1),
    });

    assert.equal(stats.warnings.filter((w) => w.message.includes('"bad"')).length, 1);
  });

  test('a review pass that is cut off splits the chunk too', async () => {
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            { keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, v.toUpperCase()])) },
          ]),
        );
      },
      async reviewChunk({ chunk, initial }) {
        if (Object.keys(chunk.keys).length > 2) throw truncated();
        return initial;
      },
    };

    const { translations, failure } = await translateJson({
      logger: silent,
      sourceFlat: four,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, review: true },
      engine,
    });

    assert.equal(failure, undefined);
    assert.equal(Object.keys(translations.fr).length, 4);
  });
});

describe('translateJson — failure code collapsing', () => {
  /** Every chunk fails the same way, the way a bad API key behaves. */
  function alwaysFails(err: Error): EngineAdapter {
    return {
      async translateChunk() {
        throw err;
      },
    };
  }

  test('a uniform non-retryable failure surfaces its own code, not CHUNK_FAILED', async () => {
    const { failure } = await translateJson({
      logger: silent,
      sourceFlat: { hello: 'world' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: alwaysFails(new LoquiError('AUTH', 'OpenAI API error 401: invalid key')),
    });

    assert.ok(failure instanceof LoquiError);
    assert.equal(failure.code, 'AUTH', 'a bad key is an auth problem, not a chunking problem');
    assert.match(failure.message, /invalid key/);
  });

  test('a mixed failure stays CHUNK_FAILED', async () => {
    // AUTH goes second: an AUTH rejection stops the pool, so nothing could follow it
    const errors = [new LoquiError('RATE_LIMIT', 'slow down'), new LoquiError('AUTH', 'bad key')];
    let call = 0;
    const engine: EngineAdapter = {
      async translateChunk() {
        throw errors[call++ % errors.length];
      },
    };

    const { failure } = await translateJson({
      logger: silent,
      sourceFlat: { a: 'a'.repeat(3000), b: 'b'.repeat(3000) },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, splitToken: 500, concurrency: 1 },
      engine,
    });

    assert.ok(failure instanceof LoquiError);
    assert.equal(failure.code, 'CHUNK_FAILED');
  });

  test('a partial failure stays CHUNK_FAILED even when the codes match', async () => {
    let call = 0;
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        // not AUTH: an AUTH rejection stops the pool, so a later chunk could not succeed
        if (call++ === 0) throw new LoquiError('RATE_LIMIT', 'slow down');
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'ok'])) };
        }
        return result;
      },
    };

    const { failure } = await translateJson({
      logger: silent,
      sourceFlat: { a: 'a'.repeat(3000), b: 'b'.repeat(3000) },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, splitToken: 500, concurrency: 1 },
      engine,
    });

    assert.ok(failure instanceof LoquiError);
    assert.equal(failure.code, 'CHUNK_FAILED', 'something did succeed, so the run was partial');
  });

  test('a non-LoquiError failure stays CHUNK_FAILED', async () => {
    const { failure } = await translateJson({
      logger: silent,
      sourceFlat: { hello: 'world' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: alwaysFails(new Error('something odd')),
    });

    assert.equal(failure?.code, 'CHUNK_FAILED');
  });

  test('a successful run carries no failure', async () => {
    const { failure } = await translateJson({
      logger: silent,
      sourceFlat: { hello: 'world' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: makeEngine(),
    });

    assert.equal(failure, undefined);
  });
});
