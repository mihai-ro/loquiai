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
  test('throws LoquiError CHUNK_FAILED when a chunk fails', async () => {
    const engine: EngineAdapter = {
      async translateChunk() {
        throw new Error('API exploded');
      },
    };

    await assert.rejects(
      () =>
        translateJson({
          sourceFlat: { hello: 'world' },
          from: 'en',
          to: ['fr'],
          namespace: 'test',
          config,
          engine,
        }),
      (err: unknown) => {
        assert.ok(err instanceof LoquiError);
        assert.equal(err.code, 'CHUNK_FAILED');
        assert.ok(err.message.includes('chunk(s) failed'));
        return true;
      },
    );
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
