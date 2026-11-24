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

describe('translateJson — translation memory hit rate', () => {
  test('a partial memory hit serves the cached locale and sends only the rest', async () => {
    const sourceFlat = { alpha: 'Alpha' };
    // fr is cached, de is not
    const translationMemory = { [memoryKey('Alpha')]: { fr: 'FROM-TM-fr' } };
    const asked: string[][] = [];

    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
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
      async translateChunk({ chunk, targetLocales }) {
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

describe('translateJson — --force and translation memory', () => {
  const sourceFlat = { one: 'One', two: 'Two', blank: '' };
  const remembered = () => ({
    [memoryKey('One')]: { fr: 'UN-FROM-MEMORY' },
    [memoryKey('Two')]: { fr: 'DEUX-FROM-MEMORY' },
  });

  function recordingEngine(sent: string[]): EngineAdapter {
    return {
      async translateChunk({ chunk, targetLocales }) {
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

describe('translateJson — glossary enforcement', () => {
  test('keeps noTranslate terms verbatim in the output', async () => {
    // Engine echoes the (masked) value back — restore must reinstate original term
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
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
      async translateChunk({ chunk, targetLocales }) {
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
    assert.ok(stats.warnings.some((w) => w.message.includes('missing glossary term')));
  });

  test('saves a key when locked glossary term is present in translation', async () => {
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
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

describe('translateJson — review pass', () => {
  test('review pass overrides initial translation when config.review = true', async () => {
    const reviewEngine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'initial'])) };
        }
        return result;
      },
      async reviewChunk({ targetLocales }) {
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
      async translateChunk({ chunk, targetLocales }) {
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
      async translateChunk({ chunk, targetLocales }) {
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'T'])) };
        }
        return result;
      },
      async reviewChunk({ initial }) {
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
