import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashValue } from './hasher.js';
import { memoryKey } from './translation-memory.js';
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

    assert.equal(updatedHashStore.fr.greeting, hashValue('Hello'));
    assert.equal(updatedHashStore.fr.bye, hashValue('Goodbye'));
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
    assert.equal(updatedHashStore.fr.greeting, hashValue('Hello'));
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

    assert.equal(updatedHashStore.fr.greeting, hashValue('Hello'));
  });

  test('changed source key is re-translated on second run', async () => {
    const source = { greeting: 'Hello!' }; // changed
    const existing = { fr: { greeting: 'Bonjour' } };
    const hashStore = { fr: { greeting: hashValue('Hello') } }; // hash from previous value

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
      async translateChunk({ chunk, targetLocales }) {
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
    const hashStore = { fr: { greeting: hashValue('Hello') } }; // hash matches current source

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

    assert.equal(run2.updatedHashStore.fr.greeting, hashValue('Hello!'));
    assert.notEqual(run2.updatedHashStore.fr.greeting, run1.updatedHashStore.fr.greeting);
  });
});

describe('translateJson — a changed key that did not land', () => {
  const oldHash = hashValue('Old text');
  const newSource = 'New text';

  /** Throws for any chunk holding `failOn`; uppercases the rest. Records what it was sent. */
  function recordingEngine(failOn: string[], sent: string[] = []): EngineAdapter {
    return {
      async translateChunk({ chunk, targetLocales }) {
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
  const hashStore = { fr: { changed: oldHash } };

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

    assert.equal(updatedHashStore.fr.changed, oldHash, 'a stale value must not be recorded as current');
  });

  test('does not write the stale value to translation memory under the new hash', async () => {
    const { updatedTranslationMemory } = await runWithFailingChunk();

    assert.equal(updatedTranslationMemory[memoryKey(newSource, 'changed')], undefined);
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

  test('a key skipped for one locale keeps its old hash there and is remembered only for the locale that landed', async () => {
    // de drops the placeholder, so its result is rejected; fr keeps it
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
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
      hashStore: { fr: { changed: oldHash }, de: { changed: oldHash } },
      translationMemory: {},
      engine,
    });

    assert.equal(translations.de.changed, 'ALT ${name}', 'precondition: the de result was rejected');
    assert.equal(updatedHashStore.fr.changed, hashValue(source.changed), 'fr landed');
    assert.equal(updatedHashStore.de.changed, oldHash, 'de did not');
    assert.deepEqual(updatedTranslationMemory[memoryKey('Hello ${name}', 'changed')], { fr: 'Hello ${name}' });
  });

  describe('with one locale served from translation memory', () => {
    const memoryHash = memoryKey(newSource, 'changed');
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
        hashStore: { fr: { changed: oldHash }, de: { changed: oldHash } },
        translationMemory: translationMemory(),
        engine: recordingEngine([]),
      });

      assert.equal(translations.fr.changed, 'MEMOIRE');
      assert.equal(updatedHashStore.fr.changed, hashValue(newSource));
      assert.equal(updatedHashStore.de.changed, hashValue(newSource));
      assert.deepEqual(updatedTranslationMemory[memoryHash], { fr: 'MEMOIRE', de: 'NEW TEXT' });
    });

    test('keeps the old hash for the locale the engine fails for, and the memory entry as it was', async () => {
      const { updatedHashStore, updatedTranslationMemory, translations } = await translateJson({
        logger: silent,
        sourceFlat: { changed: newSource, fresh: 'Fresh' },
        from: 'en',
        to: ['fr', 'de'],
        namespace: 'test',
        config: { ...config, splitToken: 1 },
        existing: existingLocales,
        hashStore: { fr: { changed: oldHash }, de: { changed: oldHash } },
        translationMemory: translationMemory(),
        engine: recordingEngine(['changed']),
      });

      assert.equal(translations.fr.changed, 'MEMOIRE');
      assert.equal(updatedHashStore.fr.changed, hashValue(newSource), 'fr was served from memory');
      assert.equal(updatedHashStore.de.changed, oldHash, 'de is still owed');
      assert.deepEqual(updatedTranslationMemory[memoryHash], { fr: 'MEMOIRE' });
    });
  });
});

describe('translateJson — empty source values', () => {
  function recordingEngine(sent: string[]): EngineAdapter {
    return {
      async translateChunk({ chunk, targetLocales }) {
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
    assert.equal(first.updatedHashStore.fr.blank, hashValue(''));

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
      hashStore: { fr: { blank: hashValue(''), title: hashValue('Hi') } },
      engine: recordingEngine([]),
    });

    assert.equal(translations.fr.blank, 'KEEP');
  });
});

describe('translateJson — a blank target means not translated yet', () => {
  function recordingEngine(sent: string[]): EngineAdapter {
    return {
      async translateChunk({ chunk, targetLocales }) {
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

    assert.ok(!('title' in updatedHashStore.fr));
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
