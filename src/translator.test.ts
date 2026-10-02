import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LoquiError } from './errors.js';
import { hashValue } from './hasher.js';
import { ConcurrencyPool, chunkTranslations, translateJson } from './translator.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type LoquiConfig,
  type TranslationChunk,
  type TranslationResult,
} from './types.js';

const config: LoquiConfig = { ...CONFIG_DEFAULTS };

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
      sourceFlat: sourceV1,
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine: makeEngine(),
    });

    // Second run — source changed, re-translates and updates hash
    const run2 = await translateJson({
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

describe('ConcurrencyPool — AIMD', () => {
  test('runs all tasks and respects the initial window', async () => {
    const pool = new ConcurrencyPool(2);
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 6 }, () => async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise<void>((r) => setTimeout(r, 5));
      current--;
    });

    await pool.run(tasks);
    assert.ok(maxConcurrent <= 2, `maxConcurrent was ${maxConcurrent}, expected <= 2`);
  });

  test('onRateLimited halves the window (floor 1)', () => {
    const pool = new ConcurrencyPool(8);
    pool.onRateLimited();
    assert.equal(pool.current, 4);
    pool.onRateLimited();
    assert.equal(pool.current, 2);
    pool.onRateLimited();
    assert.equal(pool.current, 1);
    pool.onRateLimited();
    assert.equal(pool.current, 1); // floor at 1
  });

  test('onSuccess ramps up after N consecutive successes', () => {
    const pool = new ConcurrencyPool(8);
    pool.onRateLimited(); // window = 4
    for (let i = 0; i < 10; i++) pool.onSuccess();
    assert.equal(pool.current, 5);
    for (let i = 0; i < 10; i++) pool.onSuccess();
    assert.equal(pool.current, 6);
  });

  test('window never exceeds the configured max', () => {
    const pool = new ConcurrencyPool(4);
    for (let i = 0; i < 200; i++) pool.onSuccess();
    assert.equal(pool.current, 4);
  });

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
      sourceFlat: { hello: 'world' },
      from: 'en',
      to: ['fr'],
      namespace: 'test',
      config,
      engine,
    });

    assert.equal(rateLimitCalls, 1);
  });

  test('run respects window shrink mid-flight', async () => {
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const pool = new ConcurrencyPool(4);
    let inflight = 0;
    let maxAfterShrink = 0;
    let shrunk = false;
    const resolvers: Array<() => void> = [];

    const makeTask = () => () =>
      new Promise<void>((resolve) => {
        inflight++;
        if (shrunk) maxAfterShrink = Math.max(maxAfterShrink, inflight);
        resolvers.push(() => {
          inflight--;
          resolve();
        });
      });

    const tasks = Array.from({ length: 8 }, makeTask);
    const runPromise = pool.run(tasks);

    // pool dispatches 4 synchronously before hitting the first await
    assert.equal(inflight, 4);

    shrunk = true;
    pool.onRateLimited(); // window 4 → 2

    // drain all 8 tasks one at a time; resolvers array stays populated as pool dispatches
    for (let i = 0; i < 8; i++) {
      const resolve = resolvers.shift();
      assert.ok(resolve, `expected resolver at step ${i}`);
      resolve();
      await tick();
    }
    await runPromise;

    assert.ok(maxAfterShrink <= 2, `max concurrency after rate limit: ${maxAfterShrink}, expected <= 2`);
  });

  test('run throws AggregateError when tasks fail', async () => {
    const pool = new ConcurrencyPool(2);
    const boom = new Error('task exploded');
    const tasks = [
      async () => {
        throw boom;
      },
      async () => {},
      async () => {
        throw new Error('another failure');
      },
    ];

    await assert.rejects(
      () => pool.run(tasks),
      (err: unknown) => {
        assert.ok(err instanceof AggregateError);
        assert.equal(err.errors.length, 2);
        assert.equal(err.errors[0], boom);
        return true;
      },
    );
  });

  test('run does not call onSuccess for failed tasks', async () => {
    const pool = new ConcurrencyPool(4);
    const successCount = { value: 0 };
    const origOnSuccess = pool.onSuccess.bind(pool);
    pool.onSuccess = () => {
      successCount.value++;
      origOnSuccess();
    };

    const tasks = [
      async () => {},
      async () => {
        throw new Error('fail');
      },
      async () => {},
    ];
    await assert.rejects(() => pool.run(tasks));
    assert.equal(successCount.value, 2);
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

    assert.equal(updatedTranslationMemory[hashValue(newSource)], undefined);
  });

  test('sends the key to the engine again on the next run', async () => {
    const first = await runWithFailingChunk();

    const sent: string[] = [];
    await translateJson({
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
    assert.deepEqual(updatedTranslationMemory[hashValue('Hello ${name}')], { fr: 'Hello ${name}' });
  });

  describe('with one locale served from translation memory', () => {
    const memoryHash = hashValue(newSource);
    const translationMemory = () => ({ [memoryHash]: { fr: 'MEMOIRE' } });
    const existingLocales = { fr: { changed: 'ANCIENNE' }, de: { changed: 'ALTE' } };

    test('records the new hash and both locales once the engine delivers the other one', async () => {
      const { updatedHashStore, updatedTranslationMemory, translations } = await translateJson({
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
    const errors = [new LoquiError('AUTH', 'bad key'), new LoquiError('RATE_LIMIT', 'slow down')];
    let call = 0;
    const engine: EngineAdapter = {
      async translateChunk() {
        throw errors[call++ % errors.length];
      },
    };

    const { failure } = await translateJson({
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
        if (call++ === 0) throw new LoquiError('AUTH', 'bad key');
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'ok'])) };
        }
        return result;
      },
    };

    const { failure } = await translateJson({
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
    const translationMemory = { [hashValue('Alpha')]: { fr: 'FROM-TM-fr' } };
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
      sourceFlat: { alpha: 'Alpha' },
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      translationMemory: { [hashValue('Alpha')]: { fr: 'TM-fr', de: 'TM-de' } },
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

describe('chunkTranslations — key-count bound', () => {
  function makeFlat(n: number): Record<string, string> {
    return Object.fromEntries(Array.from({ length: n }, (_, i) => [`key${i}`, 'value']));
  }

  test('single locale: allows up to 90 keys per chunk', () => {
    const flat = makeFlat(90);
    const chunks = chunkTranslations(flat, 999_999, 1);
    assert.equal(chunks.length, 1);
    assert.equal(Object.keys(chunks[0].keys).length, 90);
  });

  test('single locale: splits at 91 keys', () => {
    const flat = makeFlat(91);
    const chunks = chunkTranslations(flat, 999_999, 1);
    assert.equal(chunks.length, 2);
  });

  test('10 locales: max 9 keys per chunk (floor(90/10))', () => {
    const flat = makeFlat(10);
    const chunks = chunkTranslations(flat, 999_999, 10);
    assert.equal(chunks.length, 2); // 10 keys → ceil(10/9) = 2 chunks
    assert.ok(Object.keys(chunks[0].keys).length <= 9);
  });

  test('20 locales: max 4 keys per chunk (floor(90/20))', () => {
    const flat = makeFlat(20);
    const chunks = chunkTranslations(flat, 999_999, 20);
    // floor(90/20)=4, so 20 keys → 5 chunks
    assert.equal(chunks.length, 5);
    for (const chunk of chunks) {
      assert.ok(Object.keys(chunk.keys).length <= 4);
    }
  });

  test('token limit still splits before key limit', () => {
    // 2 locales → max 45 keys. But tiny splitToken forces 1 key per chunk.
    const flat = makeFlat(5);
    const chunks = chunkTranslations(flat, 1, 2);
    assert.equal(chunks.length, 5);
  });

  test('single key always produces exactly one chunk regardless of localeCount', () => {
    const chunks = chunkTranslations({ onlyKey: 'val' }, 999_999, 100);
    assert.equal(chunks.length, 1);
    assert.deepEqual(Object.keys(chunks[0].keys), ['onlyKey']);
  });

  test('each chunk has locales × keys ≤ 90', () => {
    const localeCount = 7;
    const flat = makeFlat(50);
    const chunks = chunkTranslations(flat, 999_999, localeCount);
    for (const chunk of chunks) {
      assert.ok(localeCount * Object.keys(chunk.keys).length <= 90);
    }
  });
});

describe('translateJson — per-locale key isolation', () => {
  const sourceFlat = { alpha: 'Alpha', beta: 'Beta' };
  // de already has alpha, hand-written; it is active only because beta is missing.
  const existing = { de: { alpha: 'HAND-EDITED-BY-HUMAN' }, fr: {} };

  test('a translated key is not written to a locale that already had it', async () => {
    const { translations } = await translateJson({
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
      [hashValue('Alpha')]: { fr: 'STALE-FROM-TM-fr', de: 'STALE-FROM-TM-de' },
    };

    const { translations } = await translateJson({
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
      sourceFlat,
      from: 'en',
      to: ['fr', 'de'],
      namespace: 'test',
      config,
      existing,
      translationMemory: {},
      engine: makeEngine((v) => `${v}-translated`),
    });

    const alphaEntry = updatedTranslationMemory[hashValue('Alpha')] ?? {};
    assert.equal(alphaEntry.fr, 'Alpha-translated');
    assert.ok(!('de' in alphaEntry), "de's pre-existing value is not a translation of this source hash");
  });
});
