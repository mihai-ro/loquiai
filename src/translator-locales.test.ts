import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LoquiError } from './errors.js';
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

describe('translateJson — each key goes only to the locales that need it', () => {
  interface Call {
    locales: string[];
    keys: string[];
  }

  function recordingEngine(calls: Call[]): EngineAdapter {
    return {
      async translateChunk({ chunk, targetLocales }) {
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
      result.stats.warnings.some((w) => w.message.includes('untranslated') && w.message.includes('greeting')),
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
      result.stats.warnings.every((w) => !w.message.includes('untranslated')),
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
      result.stats.warnings.some((w) => w.message.includes('hallucination') && w.message.includes('key')),
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
      result.stats.warnings.every((w) => !w.message.includes('hallucination')),
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

describe('translateJson — rate-limit signal', () => {
  /**
   * One engine shared by two runs. `limited` is the namespace whose requests report a 429.
   * For each run it records how many of its requests were in flight when each later one
   * started, which is what the run's own pool allows.
   */
  async function inFlightAfterTheFirstBatch(limited: string) {
    const inFlight: Record<string, number> = { alpha: 0, beta: 0 };
    const started: Record<string, number> = { alpha: 0, beta: 0 };
    const late: Record<string, number[]> = { alpha: [], beta: [] };
    const reported: Record<string, number> = { alpha: 0, beta: 0 };

    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales, namespace, onRateLimited }) {
        inFlight[namespace]++;
        if (started[namespace]++ >= 4) late[namespace].push(inFlight[namespace]);
        if (namespace === limited) {
          reported[namespace]++;
          onRateLimited();
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight[namespace]--;
        return Object.fromEntries(targetLocales.map((l) => [l, { keys: { ...chunk.keys } }]));
      },
    };

    const run = (namespace: string) =>
      translateJson({
        logger: silent,
        // splitToken 1 puts each key in its own chunk, so the run makes 12 requests
        sourceFlat: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, `value ${i}`])),
        from: 'en',
        to: ['fr'],
        namespace,
        config: { ...config, splitToken: 1, concurrency: 4 },
        engine,
      });
    await Promise.all([run('alpha'), run('beta')]);
    return { late, reported };
  }

  test('a 429 in one run narrows that run only, though the engine is shared', async () => {
    const { late, reported } = await inFlightAfterTheFirstBatch('alpha');

    assert.equal(reported.beta, 0);
    assert.ok(reported.alpha > 0);
    assert.equal(Math.max(...late.alpha), 1, 'alpha backed off to one request at a time');
    assert.equal(Math.max(...late.beta), 4, 'beta kept its full concurrency');
  });

  test('the signal each request carries belongs to the run that sent it', async () => {
    const seen: Record<string, Set<() => void>> = { alpha: new Set(), beta: new Set() };
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales, namespace, onRateLimited }) {
        seen[namespace].add(onRateLimited);
        return Object.fromEntries(targetLocales.map((l) => [l, { keys: { ...chunk.keys } }]));
      },
    };
    const run = (namespace: string) =>
      translateJson({
        logger: silent,
        sourceFlat: { a: 'one' },
        from: 'en',
        to: ['fr'],
        namespace,
        config,
        engine,
      });

    await Promise.all([run('alpha'), run('beta')]);

    for (const callback of seen.alpha) assert.ok(!seen.beta.has(callback));
    assert.equal(seen.alpha.size + seen.beta.size, 2);
  });
});

describe('translateJson — what an engine hands back', () => {
  /** A custom engine may answer with more than it was asked for. */
  const overreachingEngine: EngineAdapter = {
    async translateChunk({ chunk, targetLocales }) {
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
