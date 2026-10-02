import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LoquiError } from './errors.js';
import { hashValue } from './hasher.js';
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

/** Engine that uppercases every value — deterministic, no network calls. */
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

describe('translateJson — placeholder validation', () => {
  test('skips a translation where the LLM dropped a placeholder token', async () => {
    // Engine simulates an LLM that strips ⟦1⟧ to just "1"
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          const keys: Record<string, string> = {};
          for (const [k, v] of Object.entries(chunk.keys)) {
            // Corrupt ⟦1⟧ → "1", keep ⟦0⟧ intact
            keys[k] = v.replace('⟦1⟧', '1');
          }
          result[locale] = { keys };
        }
        return result;
      },
    };

    const source = { desc: 'Assign ${GLOSSARY.ROLE_PLURAL} to ${GLOSSARY.USER_PLURAL}' };
    const existing = { fr: { desc: 'existing translation' } };

    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat: source,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing,
      force: true, // ensures the key goes through the engine even though it already exists
      engine,
    });

    // Broken translation must NOT overwrite the existing one
    assert.equal(translations.fr.desc, 'existing translation');
    // Warning must be emitted
    assert.ok(stats.warnings.some((w) => w.includes('desc') && w.includes('${GLOSSARY.USER_PLURAL}')));
  });

  test('does not skip a translation where all placeholders are preserved', async () => {
    const source = { desc: 'Hello ${name}' };

    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat: source,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      // Engine returns the masked token verbatim → restore puts ${name} back
      engine: makeEngine((v) => `Bonjour ${v.match(/⟦\d+⟧/)?.[0] ?? ''}`),
    });

    assert.ok(translations.fr.desc?.includes('${name}'));
    assert.equal(stats.warnings.filter((w) => w.includes('missing placeholders')).length, 0);
  });
});

describe('translateJson — hash generation', () => {
  test('hash file is populated after first translation', async () => {
    const source = { greeting: 'Hello', bye: 'Goodbye' };
    const { updatedHashStore } = await translateJson({
      logger: silent,
      sourceFlat: source,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: makeEngine(),
    });

    assert.equal(updatedHashStore.greeting, hashValue('Hello'));
    assert.equal(updatedHashStore.bye, hashValue('Goodbye'));
  });

  test('hashes are saved even when nothing needs translating (all keys already exist, no hash previously stored)', async () => {
    const source = { greeting: 'Hello' };
    const existing = { fr: { greeting: 'Bonjour' } }; // already translated, no hash stored yet

    const { updatedHashStore } = await translateJson({
      logger: silent,
      sourceFlat: source,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing,
      engine: makeEngine(),
    });

    // Hash must be written even though nothing was translated
    assert.equal(updatedHashStore.greeting, hashValue('Hello'));
  });

  test('hashes are saved after --force run', async () => {
    const source = { greeting: 'Hello' };
    const existing = { fr: { greeting: 'Bonjour' } };

    const { updatedHashStore } = await translateJson({
      logger: silent,
      sourceFlat: source,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing,
      force: true,
      engine: makeEngine(),
    });

    assert.equal(updatedHashStore.greeting, hashValue('Hello'));
  });

  test('changed source key is re-translated on second run', async () => {
    const source = { greeting: 'Hello!' }; // changed
    const existing = { fr: { greeting: 'Bonjour' } };
    const hashStore = { greeting: hashValue('Hello') }; // hash from previous value

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat: source,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing,
      hashStore,
      engine: makeEngine(),
    });

    // Key was changed, so it should be re-translated
    assert.equal(translations.fr.greeting, 'HELLO!');
  });

  test('unchanged source key is NOT re-translated when hash matches', async () => {
    let callCount = 0;
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        callCount++;
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          const keys: Record<string, string> = {};
          for (const [k, v] of Object.entries(chunk.keys)) keys[k] = v.toUpperCase();
          result[locale] = { keys };
        }
        return result;
      },
    };

    const source = { greeting: 'Hello' };
    const existing = { fr: { greeting: 'Bonjour' } };
    const hashStore = { greeting: hashValue('Hello') }; // hash matches current source

    await translateJson({
      logger: silent,
      sourceFlat: source,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing,
      hashStore,
      engine,
    });

    assert.equal(callCount, 0, 'engine should not be called when source is unchanged');
  });

  test('updated hash store reflects current source after second run', async () => {
    const sourceV1 = { greeting: 'Hello' };
    const sourceV2 = { greeting: 'Hello!' };

    // First run — bootstraps hashes
    const run1 = await translateJson({
      logger: silent,
      sourceFlat: sourceV1,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: makeEngine(),
    });

    // Second run — source changed, re-translates and updates hash
    const run2 = await translateJson({
      logger: silent,
      sourceFlat: sourceV2,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: run1.translations.fr },
      hashStore: run1.updatedHashStore,
      engine: makeEngine(),
    });

    assert.equal(run2.updatedHashStore.greeting, hashValue('Hello!'));
    assert.notEqual(run2.updatedHashStore.greeting, run1.updatedHashStore.greeting);
  });
});

describe('translateJson — chunk failure handling', () => {
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
    assert.ok(stats.warnings.some((w) => w.includes('API exploded')));
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

    assert.equal(updatedHashStore.keep, hashValue('kept'));
    assert.ok(!('boom' in updatedHashStore), 'a hash for an undelivered key would make the next run skip it');
  });

  test('a key missing from one locale is not recorded as done', async () => {
    // fr succeeds, de is dropped by the engine entirely
    const engine: EngineAdapter = {
      async translateChunk(chunk) {
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

    assert.ok(!('hello' in updatedHashStore));
  });
});

describe('translateJson — a changed key that did not land', () => {
  const oldHash = hashValue('Old text');
  const newSource = 'New text';

  /** Throws for any chunk holding `failOn`; uppercases the rest. Records what it was sent. */
  function recordingEngine(failOn: string[], sent: string[] = []): EngineAdapter {
    return {
      async translateChunk(chunk, targetLocales) {
        sent.push(...Object.keys(chunk.keys));
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

  // `changed` has a stale fr value and an old hash; `fresh` gives the run a chunk that succeeds.
  const sourceFlat = { changed: newSource, fresh: 'Fresh' };
  const existing = { fr: { changed: 'ANCIENNE' } };
  const hashStore = { changed: oldHash };

  function runWithFailingChunk(sent: string[] = []) {
    return translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      // splitToken of 1 puts each key in its own chunk, so `changed` can fail alone
      config: { ...config, splitToken: 1 },
      existing,
      hashStore,
      translationMemory: {},
      engine: recordingEngine(['changed'], sent),
    });
  }

  test('keeps the old hash when its chunk fails', async () => {
    const { updatedHashStore } = await runWithFailingChunk();

    assert.equal(updatedHashStore.changed, oldHash, 'a stale value must not be recorded as current');
  });

  test('does not write the stale value to translation memory under the new hash', async () => {
    const { updatedTranslationMemory } = await runWithFailingChunk();

    assert.equal(updatedTranslationMemory[memoryKey(newSource)], undefined);
  });

  test('sends the key to the engine again on the next run', async () => {
    const first = await runWithFailingChunk();

    const sent: string[] = [];
    await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, splitToken: 1 },
      existing: first.translations,
      hashStore: first.updatedHashStore,
      translationMemory: first.updatedTranslationMemory,
      engine: recordingEngine([], sent),
    });

    assert.deepEqual(sent, ['changed'], 'the retry is the gap and nothing else');
  });

  test('a key skipped for one locale keeps its old hash and is remembered only for the locale that landed', async () => {
    // de drops the placeholder, so its result is rejected; fr keeps it
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = {
            keys: Object.fromEntries(
              Object.entries(chunk.keys).map(([k, v]) => [k, locale === 'de' ? v.replace(/⟦\d+⟧/g, '') : v]),
            ),
          };
        }
        return result;
      },
    };
    const source = { changed: 'Hello ${name}' };

    const { updatedHashStore, updatedTranslationMemory, translations } = await translateJson({
      logger: silent,
      sourceFlat: source,
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      existing: { fr: { changed: 'ANCIEN ${name}' }, de: { changed: 'ALT ${name}' } },
      hashStore: { changed: oldHash },
      translationMemory: {},
      engine,
    });

    assert.equal(translations.de.changed, 'ALT ${name}', 'precondition: the de result was rejected');
    assert.equal(updatedHashStore.changed, oldHash);
    assert.deepEqual(updatedTranslationMemory[memoryKey('Hello ${name}')], { fr: 'Hello ${name}' });
  });

  describe('with one locale served from translation memory', () => {
    const memoryHash = memoryKey(newSource);
    const translationMemory = () => ({ [memoryHash]: { fr: 'MEMOIRE' } });
    const existingLocales = { fr: { changed: 'ANCIENNE' }, de: { changed: 'ALTE' } };

    test('records the new hash and both locales once the engine delivers the other one', async () => {
      const { updatedHashStore, updatedTranslationMemory, translations } = await translateJson({
        logger: silent,
        sourceFlat: { changed: newSource },
        from: 'en',
        to: ['fr', 'de'],
        namespace: 'test',
        config,
        existing: existingLocales,
        hashStore: { changed: oldHash },
        translationMemory: translationMemory(),
        engine: recordingEngine([]),
      });

      assert.equal(translations.fr.changed, 'MEMOIRE');
      assert.equal(updatedHashStore.changed, hashValue(newSource));
      assert.deepEqual(updatedTranslationMemory[memoryHash], { fr: 'MEMOIRE', de: 'NEW TEXT' });
    });

    test('keeps the old hash and the memory entry as it was when the engine fails for the other one', async () => {
      const { updatedHashStore, updatedTranslationMemory, translations } = await translateJson({
        logger: silent,
        sourceFlat: { changed: newSource, fresh: 'Fresh' },
        from: 'en',
        to: ['fr', 'de'],
        namespace: 'test',
        config: { ...config, splitToken: 1 },
        existing: existingLocales,
        hashStore: { changed: oldHash },
        translationMemory: translationMemory(),
        engine: recordingEngine(['changed']),
      });

      assert.equal(translations.fr.changed, 'MEMOIRE');
      assert.equal(updatedHashStore.changed, oldHash);
      assert.deepEqual(updatedTranslationMemory[memoryHash], { fr: 'MEMOIRE' });
    });
  });
});

describe('translateJson — a malformed ICU value', () => {
  const UNBALANCED = '{g, select, male {he} other {they}} bought {n, plural, one {# item} other {# items}';

  function recordingEngine(sent: string[]): EngineAdapter {
    return {
      async translateChunk(chunk, targetLocales) {
        sent.push(...Object.keys(chunk.keys));
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

  test('is left out of the chunk, named in a warning, and does not take its neighbours down', async () => {
    const sent: string[] = [];

    const { translations, stats, failure } = await translateJson({
      logger: silent,
      sourceFlat: { greeting: 'Hello', bought: UNBALANCED, farewell: 'Goodbye' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent.sort(), ['farewell', 'greeting'], 'the malformed value must never reach the engine');
    assert.ok(
      stats.warnings.some((w) => w.includes('"bought"')),
      'the warning has to name the key',
    );
    assert.equal(translations.fr.greeting, 'HELLO');
    assert.equal(translations.fr.farewell, 'GOODBYE');
    assert.equal(translations.fr.bought, undefined);
    assert.equal(failure, undefined, 'one skipped value is not a failed chunk');
    assert.equal(stats.failedChunks, 0);
  });

  test('is not recorded as done, so the next run reports it again', async () => {
    const { updatedHashStore } = await translateJson({
      logger: silent,
      sourceFlat: { greeting: 'Hello', bought: UNBALANCED },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: recordingEngine([]),
    });

    assert.equal(updatedHashStore.greeting, hashValue('Hello'));
    assert.ok(!('bought' in updatedHashStore));
  });

  test('makes no engine call for a chunk where every value is malformed', async () => {
    const sent: string[] = [];

    const { stats } = await translateJson({
      logger: silent,
      sourceFlat: { bought: UNBALANCED },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent, []);
    assert.equal(stats.apiRequests, 0);
    assert.ok(stats.warnings.some((w) => w.includes('"bought"')));
  });

  test('an invalid placeholder pattern still fails the run', async () => {
    const { failure, stats } = await translateJson({
      logger: silent,
      sourceFlat: { greeting: 'Hello' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, placeholderPatterns: ['('] },
      engine: recordingEngine([]),
    });

    assert.ok(failure, 'a config error must not be swallowed as a skipped key');
    assert.equal(stats.failedChunks, 1);
    assert.ok(stats.warnings.some((w) => w.includes('Invalid placeholder pattern')));
  });
});

describe('translateJson — empty source values', () => {
  function recordingEngine(sent: string[]): EngineAdapter {
    return {
      async translateChunk(chunk, targetLocales) {
        sent.push(...Object.keys(chunk.keys));
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

  const sourceFlat = { blank: '', title: 'Hi' };

  test('are copied to every locale and never sent to the engine', async () => {
    const sent: string[] = [];

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent, ['title']);
    assert.equal(translations.fr.blank, '');
    assert.equal(translations.de.blank, '');
    assert.equal(translations.fr.title, 'HI');
  });

  test('are not counted as translated, and a whitespace-only value is copied as it is', async () => {
    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat: { gap: '  ', title: 'Hi' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: recordingEngine([]),
    });

    assert.equal(translations.fr.gap, '  ');
    assert.equal(stats.keysTranslated, 1);
  });

  test('are recorded as done, so the next run over the output makes no request', async () => {
    const first = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: recordingEngine([]),
    });
    assert.equal(first.updatedHashStore.blank, hashValue(''));

    const sent: string[] = [];
    const second = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: first.translations,
      hashStore: first.updatedHashStore,
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent, []);
    assert.equal(second.stats.apiRequests, 0);
  });

  test('are copied under --force as well', async () => {
    const sent: string[] = [];

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: { blank: 'STALE', title: 'OLD' } },
      force: true,
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent, ['title']);
    assert.equal(translations.fr.blank, '');
  });

  test('leave a value already in the target alone while the source is unchanged', async () => {
    const { translations } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: { blank: 'KEEP', title: 'SALUT' } },
      hashStore: { blank: hashValue(''), title: hashValue('Hi') },
      engine: recordingEngine([]),
    });

    assert.equal(translations.fr.blank, 'KEEP');
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
      async translateChunk(chunk, targetLocales) {
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
      async translateChunk(chunk, targetLocales) {
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
      async translateChunk(chunk, targetLocales) {
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
      async translateChunk(chunk, targetLocales) {
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
      async translateChunk(chunk) {
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

    assert.ok(stats.warnings.some((w) => w.includes('exploded on k0+k1')));
    assert.ok(
      stats.warnings.some((w) => w.includes('exploded on k2+k3')),
      'the second half failed too',
    );
  });

  describe('the cost of splitting', () => {
    // two keys per chunk at splitToken 500; an engine that fits one key per call splits every chunk
    const wide = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`w${i}`, `${'word '.repeat(80)}${i}`]));
    const splitNotes = (warnings: string[]) => warnings.filter((w) => /re-sent in halves/.test(w));

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
      assert.ok(splitNotes(stats.warnings)[0].includes('splitToken'), 'the warning names what avoids the cost');
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

    assert.equal(stats.warnings.filter((w) => w.includes('"bad"')).length, 1);
  });

  test('a review pass that is cut off splits the chunk too', async () => {
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            { keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, v.toUpperCase()])) },
          ]),
        );
      },
      async reviewChunk(chunk, initial) {
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
      async translateChunk(chunk, targetLocales) {
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

describe('translateJson — translation memory hit rate', () => {
  test('a partial memory hit serves the cached locale and sends only the rest', async () => {
    const sourceFlat = { alpha: 'Alpha' };
    // fr is cached, de is not
    const translationMemory = { [memoryKey('Alpha')]: { fr: 'FROM-TM-fr' } };
    const asked: string[][] = [];

    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        asked.push([...targetLocales]);
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = {
            keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, `ENGINE-${locale}-${v}`])),
          };
        }
        return result;
      },
    };

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      translationMemory,
      engine,
    });

    assert.equal(translations.fr.alpha, 'FROM-TM-fr', 'the cached locale must keep its memory hit');
    assert.equal(translations.de.alpha, 'ENGINE-de-Alpha');
    assert.equal(asked.length, 1, 'the uncovered locale still needs one request');
  });

  test('a full memory hit skips the engine entirely', async () => {
    let called = false;
    const engine: EngineAdapter = {
      async translateChunk() {
        called = true;
        return {};
      },
    };

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat: { alpha: 'Alpha' },
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      translationMemory: { [memoryKey('Alpha')]: { fr: 'TM-fr', de: 'TM-de' } },
      engine,
    });

    assert.equal(called, false);
    assert.equal(translations.fr.alpha, 'TM-fr');
    assert.equal(translations.de.alpha, 'TM-de');
  });
});

describe('translateJson — locale linting', () => {
  test('warns when translation is identical to source', async () => {
    // Engine returns source unchanged — simulates model failure to translate
    const engine = makeEngine((v) => v);
    const result = await translateJson({
      logger: silent,
      sourceFlat: { greeting: 'Hello' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine,
    });
    assert.equal(result.translations.fr.greeting, 'Hello');
    assert.ok(
      result.stats.warnings.some((w) => w.includes('untranslated') && w.includes('greeting')),
      'should warn about untranslated key',
    );
  });

  test('does not warn when source locale equals target locale', async () => {
    // from === to: translation being same as source is expected
    const engine = makeEngine((v) => v);
    const result = await translateJson({
      logger: silent,
      sourceFlat: { greeting: 'Hello' },
      from: 'en',
      to: ['en'],
      namespace: 'test',
      config,
      engine,
    });
    assert.ok(
      result.stats.warnings.every((w) => !w.includes('untranslated')),
      'should not warn when source and target locale are the same',
    );
  });

  test('warns when translation is excessively long', async () => {
    // Engine returns a string > 4× source length — hallucination simulation
    const engine = makeEngine((v) => v + 'x'.repeat(v.length * 5));
    const result = await translateJson({
      logger: silent,
      sourceFlat: { key: 'Hello' },
      from: 'en',
      to: ['de'],
      namespace: 'test',
      config,
      engine,
    });
    assert.ok(
      result.stats.warnings.some((w) => w.includes('hallucination') && w.includes('key')),
      'should warn about excessively long translation',
    );
  });

  test('does not warn for normal-length translations', async () => {
    // German is ~30% longer than English — well within 4× threshold
    const engine = makeEngine((v) => v + v.slice(0, Math.floor(v.length * 0.3)));
    const result = await translateJson({
      logger: silent,
      sourceFlat: { title: 'Schedule' },
      from: 'en',
      to: ['de'],
      namespace: 'test',
      config,
      engine,
    });
    assert.ok(
      result.stats.warnings.every((w) => !w.includes('hallucination')),
      'should not warn for normal translation length',
    );
  });

  test('still saves translation even when untranslated warning fires', async () => {
    const engine = makeEngine((v) => v);
    const result = await translateJson({
      logger: silent,
      sourceFlat: { brand: 'Acme' },
      from: 'en',
      to: ['ja'],
      namespace: 'test',
      config,
      engine,
    });
    // Value is saved despite warning (could be a proper noun)
    assert.equal(result.translations.ja.brand, 'Acme');
  });
});

describe('translateJson — review pass', () => {
  test('review pass overrides initial translation when config.review = true', async () => {
    const reviewEngine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'initial'])) };
        }
        return result;
      },
      async reviewChunk(_chunk, _initial, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = { keys: { greeting: 'reviewed' } };
        }
        return result;
      },
    };

    const result = await translateJson({
      logger: silent,
      sourceFlat: { greeting: 'Hello' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, review: true },
      engine: reviewEngine,
    });

    assert.equal(result.translations.fr.greeting, 'reviewed');
  });

  test('review pass not called when config.review = false', async () => {
    let reviewCalled = false;
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'TRANSLATED'])) };
        }
        return result;
      },
      async reviewChunk() {
        reviewCalled = true;
        return {};
      },
    };

    await translateJson({
      logger: silent,
      sourceFlat: { greeting: 'Hello' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, review: false },
      engine,
    });

    assert.equal(reviewCalled, false);
  });

  test('review pass increments apiRequests twice', async () => {
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'T'])) };
        }
        return result;
      },
      async reviewChunk(_chunk, initial) {
        return initial;
      },
    };

    const result = await translateJson({
      logger: silent,
      sourceFlat: { k: 'v' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, review: true },
      engine,
    });

    assert.equal(result.stats.apiRequests, 2);
  });

  test('engine without reviewChunk skips review even if config.review = true', async () => {
    // EngineAdapter with no reviewChunk — review silently skipped
    const engine = makeEngine((v) => `TRANSLATED_${v}`);
    const result = await translateJson({
      logger: silent,
      sourceFlat: { key: 'Hello' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config: { ...config, review: true },
      engine,
    });
    assert.equal(result.stats.apiRequests, 1);
    assert.ok(result.translations.fr.key.startsWith('TRANSLATED_'));
  });
});

describe('translateJson — glossary enforcement', () => {
  test('keeps noTranslate terms verbatim in the output', async () => {
    // Engine echoes the (masked) value back — restore must reinstate original term
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          const keys: Record<string, string> = {};
          for (const [k, v] of Object.entries(chunk.keys)) {
            keys[k] = v; // echo masked value verbatim
          }
          result[locale] = { keys };
        }
        return result;
      },
    };

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat: { greeting: 'Welcome to Loqui' },
      from: 'en',
      to: ['es'],
      namespace: 'test',
      config,
      engine,
      glossaryModel: { terms: {}, noTranslate: ['Loqui'] },
    });

    assert.ok(translations.es.greeting?.includes('Loqui'), 'Loqui must survive translation verbatim');
    assert.ok(!translations.es.greeting?.includes('⟦T'), 'no sentinel tokens should remain in output');
  });

  test('skips a key whose translation drops a locked glossary term', async () => {
    // Engine returns translation WITHOUT the locked term "Tablero"
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = {
            keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'Resumen general'])),
          };
        }
        return result;
      },
    };

    const existing = { es: { title: 'existing value' } };
    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat: { title: 'Dashboard overview' },
      from: 'en',
      to: ['es'],
      namespace: 'test',
      config,
      existing,
      force: true,
      engine,
      glossaryModel: { terms: { Dashboard: { es: 'Tablero' } }, noTranslate: [] },
    });

    // key skipped → existing value preserved (retry next run)
    assert.equal(translations.es.title, 'existing value');
    assert.ok(stats.warnings.some((w) => w.includes('missing glossary term')));
  });

  test('saves a key when locked glossary term is present in translation', async () => {
    const engine: EngineAdapter = {
      async translateChunk(chunk, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = {
            keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'Resumen del Tablero'])),
          };
        }
        return result;
      },
    };

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat: { title: 'Dashboard overview' },
      from: 'en',
      to: ['es'],
      namespace: 'test',
      config,
      engine,
      glossaryModel: { terms: { Dashboard: { es: 'Tablero' } }, noTranslate: [] },
    });

    assert.equal(translations.es.title, 'Resumen del Tablero');
  });
});

describe('translateJson — each key goes only to the locales that need it', () => {
  interface Call {
    locales: string[];
    keys: string[];
  }

  function recordingEngine(calls: Call[]): EngineAdapter {
    return {
      async translateChunk(chunk, targetLocales) {
        calls.push({ locales: [...targetLocales], keys: Object.keys(chunk.keys) });
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = {
            keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, `${locale}:${v}`])),
          };
        }
        return result;
      },
    };
  }

  const valuesAsked = (calls: Call[]) => calls.reduce((sum, c) => sum + c.keys.length * c.locales.length, 0);

  // ja has nothing; fr has everything but k0
  const sourceFlat = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, `Text ${i}`]));
  const frExisting = Object.fromEntries(Object.entries(sourceFlat).filter(([k]) => k !== 'k0'));

  test('asks for each value once per locale that needs it, not once per active locale', async () => {
    const calls: Call[] = [];

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['ja', 'fr'],
      namespace: 'test',
      config,
      existing: { fr: frExisting },
      engine: recordingEngine(calls),
    });

    assert.equal(valuesAsked(calls), 21, 'k0 for ja and fr, the other 19 for ja only');
    assert.equal(Object.keys(translations.ja).length, 20);
    assert.equal(translations.fr.k0, 'fr:Text 0');
    assert.equal(translations.fr.k1, 'Text 1', 'fr kept the value it already had');
  });

  test('calls the engine with the locales of the group, in `to` order', async () => {
    const calls: Call[] = [];

    await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['ja', 'fr'],
      namespace: 'test',
      config,
      existing: { fr: frExisting },
      engine: recordingEngine(calls),
    });

    const byLocales = calls.map((c) => `${c.locales.join('+')}:${c.keys.length}`).sort();
    assert.deepEqual(byLocales, ['ja+fr:1', 'ja:19']);
  });

  test("chunks within a group by that group's own locale count", async () => {
    const calls: Call[] = [];
    // 100 keys wanted by one locale and 100 by ten: the cap is 90 values per call
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`w${i}`, `Wide ${i}`]));
    const locales = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'];

    await translateJson({
      logger: silent,
      sourceFlat: wide,
      from: 'en',
      to: locales,
      namespace: 'test',
      config,
      existing: Object.fromEntries(
        locales.slice(1).map((l) => [
          l,
          Object.fromEntries(
            Object.keys(wide)
              .slice(0, 50)
              .map((k) => [k, 'x']),
          ),
        ]),
      ),
      engine: recordingEngine(calls),
    });

    assert.ok(
      calls.every((c) => c.keys.length * c.locales.length <= 90),
      'no call may exceed the structured-output cap',
    );
    assert.equal(valuesAsked(calls), 100 + 50 * 9, 'l0 needs all 100; the other nine need the last 50');
  });

  test('a uniform failure is still reported by its own code when the groups fail together', async () => {
    const engine: EngineAdapter = {
      async translateChunk() {
        throw new LoquiError('AUTH', 'invalid key');
      },
    };

    const { failure } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['ja', 'fr'],
      namespace: 'test',
      config,
      existing: { fr: frExisting },
      engine,
    });

    assert.equal(failure?.code, 'AUTH', 'two groups, two failed requests: every request failed alike');
  });

  test('translation memory records what each locale was delivered, key by key', async () => {
    const { updatedTranslationMemory } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['ja', 'fr'],
      namespace: 'test',
      config,
      existing: { fr: frExisting },
      translationMemory: {},
      engine: recordingEngine([]),
    });

    assert.deepEqual(updatedTranslationMemory[memoryKey('Text 0')], { ja: 'ja:Text 0', fr: 'fr:Text 0' });
    assert.deepEqual(updatedTranslationMemory[memoryKey('Text 1')], { ja: 'ja:Text 1' });
  });
});

describe('translateJson — what an engine hands back', () => {
  /** A custom engine may answer with more than it was asked for. */
  const overreachingEngine: EngineAdapter = {
    async translateChunk(chunk, targetLocales) {
      const result: Record<string, TranslationResult> = {};
      for (const locale of targetLocales) {
        result[locale] = {
          keys: {
            ...Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'TRANSLATED'])),
            b: 'CLOBBERED',
            rogue: 'INVENTED',
          },
        };
      }
      return result;
    },
  };

  test('a key that was not sent is neither written nor remembered', async () => {
    const { translations, updatedTranslationMemory } = await translateJson({
      logger: silent,
      sourceFlat: { a: 'A', b: 'B' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      // b is already translated and not requested; only a is sent
      existing: { fr: { b: 'KEEP' } },
      translationMemory: {},
      engine: overreachingEngine,
    });

    assert.equal(translations.fr.a, 'TRANSLATED');
    assert.equal(translations.fr.b, 'KEEP', 'an existing value the run did not ask about must survive');
    assert.ok(!('rogue' in translations.fr), 'an invented key must not reach the output');
    assert.deepEqual(Object.keys(updatedTranslationMemory), [memoryKey('A')], 'only the delivered key is remembered');
    assert.deepEqual(updatedTranslationMemory[memoryKey('A')], { fr: 'TRANSLATED' });
  });
});

describe('translateJson — translation memory does not confuse strings whose hashes collide', () => {
  /** Two different strings with the same FNV hash, found by brute force. */
  function collidingPair(): [string, string] {
    const seen = new Map<string, string>();
    for (let i = 0; i < 2_000_000; i++) {
      const candidate = `string ${i}`;
      const hash = hashValue(candidate);
      const earlier = seen.get(hash);
      if (earlier !== undefined) return [earlier, candidate];
      seen.set(hash, candidate);
    }
    throw new Error('no collision found');
  }

  function recordingEngine(sent: string[]): EngineAdapter {
    return {
      async translateChunk(chunk, targetLocales) {
        sent.push(...Object.values(chunk.keys));
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'FROM-ENGINE'])) },
          ]),
        );
      },
    };
  }

  const [first, second] = collidingPair();

  test('a remembered string is served from memory', async () => {
    const sent: string[] = [];

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat: { x: first },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      translationMemory: { [memoryKey(first)]: { fr: 'FROM-MEMORY' } },
      engine: recordingEngine(sent),
    });

    assert.equal(translations.fr.x, 'FROM-MEMORY');
    assert.deepEqual(sent, []);
  });

  test("a different string with the same hash is sent to the engine, not served the first one's translation", async () => {
    const sent: string[] = [];

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat: { x: second },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      translationMemory: { [memoryKey(first)]: { fr: 'FROM-MEMORY' } },
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent, [second]);
    assert.equal(translations.fr.x, 'FROM-ENGINE');
  });

  test('both strings are remembered separately after one run', async () => {
    const { updatedTranslationMemory } = await translateJson({
      logger: silent,
      sourceFlat: { x: first, y: second },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      translationMemory: {},
      engine: recordingEngine([]),
    });

    assert.deepEqual(Object.keys(updatedTranslationMemory).sort(), [memoryKey(first), memoryKey(second)].sort());
  });
});

describe("translateJson — a target holds only the source's keys", () => {
  test('keys the source no longer has are left out of the working target', async () => {
    const { translations } = await translateJson({
      logger: silent,
      sourceFlat: { a: 'A' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: { a: 'A-FR', stale: 'old', 'nested.gone': 'x' } },
      engine: makeEngine(),
    });

    assert.deepEqual(translations.fr, { a: 'A-FR' });
  });

  test('a source key restructured from an object to a string is translated once', async () => {
    const { translations } = await translateJson({
      logger: silent,
      sourceFlat: { a: 'x' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: { 'a.b': 'ancien' } },
      engine: makeEngine(),
    });

    assert.deepEqual(translations.fr, { a: 'X' });
  });

  test('a run with nothing to translate still returns the pruned target', async () => {
    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat: { a: 'A' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: { a: 'A-FR', stale: 'old' } },
      engine: makeEngine(),
    });

    assert.equal(stats.apiRequests, 0);
    assert.deepEqual(translations.fr, { a: 'A-FR' });
  });
});

describe('translateJson — a blank target means not translated yet', () => {
  function recordingEngine(sent: string[]): EngineAdapter {
    return {
      async translateChunk(chunk, targetLocales) {
        sent.push(...Object.keys(chunk.keys));
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            { keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, v.toUpperCase()])) },
          ]),
        );
      },
    };
  }

  test('a key whose target is blank is sent like a missing one', async () => {
    const sent: string[] = [];

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat: { title: 'Hello' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: { title: '' } },
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent, ['title']);
    assert.equal(translations.fr.title, 'HELLO');
  });

  test('a blank source with a blank target needs nothing', async () => {
    const sent: string[] = [];

    await translateJson({
      logger: silent,
      sourceFlat: { blank: '' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: { blank: '' } },
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent, []);
  });

  test('a blank target is not recorded as done until it has been translated', async () => {
    const { updatedHashStore } = await translateJson({
      logger: silent,
      sourceFlat: { title: 'Hello' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      existing: { fr: { title: '' } },
      engine: {
        async translateChunk() {
          return { fr: { keys: { title: '' } } };
        },
      },
    });

    assert.ok(!('title' in updatedHashStore));
  });
});

describe('translateJson — --force and translation memory', () => {
  const sourceFlat = { one: 'One', two: 'Two', blank: '' };
  const remembered = () => ({
    [memoryKey('One')]: { fr: 'UN-FROM-MEMORY' },
    [memoryKey('Two')]: { fr: 'DEUX-FROM-MEMORY' },
  });

  function recordingEngine(sent: string[]): EngineAdapter {
    return {
      async translateChunk(chunk, targetLocales) {
        sent.push(...Object.keys(chunk.keys));
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            { keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, `NEW-${v}`])) },
          ]),
        );
      },
    };
  }

  test('without force, a memory that holds every string makes no request', async () => {
    const sent: string[] = [];

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      translationMemory: remembered(),
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent, []);
    assert.equal(translations.fr.one, 'UN-FROM-MEMORY');
  });

  test('with force, every non-blank key goes to the engine and the memory entries are replaced', async () => {
    const sent: string[] = [];

    const { translations, updatedTranslationMemory } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      force: true,
      translationMemory: remembered(),
      engine: recordingEngine(sent),
    });

    assert.deepEqual(sent.sort(), ['one', 'two']);
    assert.equal(translations.fr.one, 'NEW-One');
    assert.equal(translations.fr.blank, '', 'a blank value is still copied, not sent');
    assert.deepEqual(updatedTranslationMemory[memoryKey('One')], { fr: 'NEW-One' });
    assert.deepEqual(updatedTranslationMemory[memoryKey('Two')], { fr: 'NEW-Two' });
  });
});

describe('translateJson — per-locale key isolation', () => {
  const sourceFlat = { alpha: 'Alpha', beta: 'Beta' };
  // de already has alpha, hand-written; it is active only because beta is missing.
  const existing = { de: { alpha: 'HAND-EDITED-BY-HUMAN' }, fr: {} };

  test('a translated key is not written to a locale that already had it', async () => {
    const { translations } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      existing,
      engine: makeEngine((v) => `${v}-translated`),
    });

    assert.equal(translations.de.alpha, 'HAND-EDITED-BY-HUMAN', 'de never requested alpha');
    assert.equal(translations.de.beta, 'Beta-translated');
    assert.equal(translations.fr.alpha, 'Alpha-translated');
    assert.equal(translations.fr.beta, 'Beta-translated');
  });

  test('a translation-memory hit is not written to a locale that already had the key', async () => {
    const translationMemory = {
      [memoryKey('Alpha')]: { fr: 'STALE-FROM-TM-fr', de: 'STALE-FROM-TM-de' },
    };

    const { translations } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      existing,
      translationMemory,
      engine: makeEngine((v) => `NEW-${v}`),
    });

    assert.equal(translations.de.alpha, 'HAND-EDITED-BY-HUMAN', 'de never requested alpha');
    assert.equal(translations.fr.alpha, 'STALE-FROM-TM-fr', 'fr did request alpha, so the TM hit applies');
    assert.equal(translations.de.beta, 'NEW-Beta');
  });

  test('--force re-translates every key for every locale', async () => {
    const { translations } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      existing,
      force: true,
      engine: makeEngine((v) => `${v}-translated`),
    });

    assert.equal(translations.de.alpha, 'Alpha-translated', 'force means every locale asked for every key');
    assert.equal(translations.fr.alpha, 'Alpha-translated');
  });

  test('translation memory records only what this run translated', async () => {
    const { updatedTranslationMemory } = await translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      existing,
      translationMemory: {},
      engine: makeEngine((v) => `${v}-translated`),
    });

    const alphaEntry = updatedTranslationMemory[memoryKey('Alpha')] ?? {};
    assert.equal(alphaEntry.fr, 'Alpha-translated');
    assert.ok(!('de' in alphaEntry), "de's pre-existing value is not a translation of this source hash");
  });
});

describe('translateJson — rate-limit signal', () => {
  test('rate limit signal is called on 429 via engine integration', async () => {
    let rateLimitCalls = 0;
    const engine: EngineAdapter = {
      setRateLimitSignal(fn) {
        // simulate 429 immediately on first chunk
        fn();
        rateLimitCalls++;
      },
      async translateChunk(chunk, targetLocales) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'translated'])) };
        }
        return result;
      },
    };

    await translateJson({
      logger: silent,
      sourceFlat: { hello: 'world' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine,
    });

    assert.equal(rateLimitCalls, 1);
  });
});
