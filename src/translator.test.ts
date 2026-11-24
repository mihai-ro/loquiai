import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashValue } from './hasher.js';
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

describe('translateJson — placeholder validation', () => {
  const greet = { greet: 'Hi {name}, you have {count}' };
  const run = (transform: (v: string) => string, sourceFlat: Record<string, string> = greet) =>
    translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['es'],
      namespace: 'test',
      config,
      engine: makeEngine(transform),
    });

  test('rejects an answer with a sentinel that was never sent', async () => {
    const { translations, stats } = await run((v) => `${v}⟦7⟧`);

    assert.equal(translations.es.greet, undefined);
    assert.deepEqual(
      stats.warnings.map((w) => w.code),
      ['PLACEHOLDER_MISMATCH'],
    );
    assert.match(stats.warnings[0].message, /never sent: ⟦7⟧/);
  });

  test('rejects an answer that repeats a sent sentinel', async () => {
    const { translations, stats } = await run((v) => v.replace('⟦0⟧', '⟦0⟧⟦0⟧'));

    assert.equal(translations.es.greet, undefined);
    assert.deepEqual(
      stats.warnings.map((w) => w.code),
      ['PLACEHOLDER_MISMATCH'],
    );
    assert.match(stats.warnings[0].message, /different number of times than sent: \{name\}/);
  });

  test('accepts placeholders that moved, since a translation may reorder them', async () => {
    const { translations, stats } = await run((v) => v.replace('⟦0⟧', '@@').replace('⟦1⟧', '⟦0⟧').replace('@@', '⟦1⟧'));

    assert.equal(translations.es.greet, 'Hi {count}, you have {name}');
    assert.deepEqual(stats.warnings, []);
  });

  test('does not send a value that already holds a sentinel character, and still translates its neighbours', async () => {
    const sent: string[] = [];
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        sent.push(...Object.keys(chunk.keys));
        return Object.fromEntries(
          targetLocales.map((locale) => [
            locale,
            { keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, v.toUpperCase()])) },
          ]),
        );
      },
    };

    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat: { bad: 'Use ⟦0⟧ then {name}', good: 'Hello' },
      from: 'en',
      to: ['es'],
      namespace: 'test',
      config,
      engine,
    });

    assert.deepEqual(sent, ['good']);
    assert.equal(translations.es.good, 'HELLO');
    assert.equal(translations.es.bad, undefined);
    assert.deepEqual(
      stats.warnings.map(({ code, key }) => ({ code, key })),
      [{ code: 'NOT_SENT', key: 'bad' }],
    );
    assert.match(stats.warnings[0].message, /⟦ or ⟧/);
  });

  test('skips a translation where the LLM dropped a placeholder token', async () => {
    // Engine simulates an LLM that strips ⟦1⟧ to just "1"
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
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
    assert.ok(stats.warnings.some((w) => w.message.includes('desc') && w.message.includes('${GLOSSARY.USER_PLURAL}')));
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
    assert.equal(stats.warnings.filter((w) => w.message.includes('missing placeholders')).length, 0);
  });

  test('accepts a tag that contains a noTranslate term', async () => {
    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat: { help: 'Contact <a href="mailto:help@schedulepop.com">SchedulePop Support</a>.' },
      from: 'en',
      to: ['es'],
      namespace: 'test',
      config,
      engine: makeEngine((v) => v.replace('Contact', 'Contacta').replace('Support', 'Soporte')),
      glossaryModel: { terms: {}, noTranslate: ['SchedulePop'] },
    });

    assert.deepEqual(stats.warnings, []);
    assert.equal(translations.es.help, 'Contacta <a href="mailto:help@schedulepop.com">SchedulePop Soporte</a>.');
  });

  test('accepts a tag that contains a placeholder', async () => {
    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat: { help: 'Contact <a href="mailto:{{email}}">us</a>.' },
      from: 'en',
      to: ['es'],
      namespace: 'test',
      config,
      engine: makeEngine((v) => v.replace('Contact', 'Contacta').replace('us', 'nos')),
    });

    assert.deepEqual(stats.warnings, []);
    assert.equal(translations.es.help, 'Contacta <a href="mailto:{{email}}">nos</a>.');
  });

  test('still rejects a dropped tag that contains nothing masked', async () => {
    const { translations, stats } = await translateJson({
      logger: silent,
      sourceFlat: { bold: 'Say <b>x</b>' },
      from: 'en',
      to: ['es'],
      namespace: 'test',
      config,
      engine: makeEngine((v) => v.replace('Say', 'Di').replace('⟦0⟧', '')),
    });

    assert.equal(translations.es.bold, undefined);
    assert.ok(stats.warnings.some((w) => w.message.includes('missing placeholders: <b>')));
    assert.deepEqual(
      stats.warnings.map(({ code, locale, key }) => ({ code, locale, key })),
      [{ code: 'PLACEHOLDER_MISMATCH', locale: 'es', key: 'bold' }],
    );
  });
});

describe('translateJson — ICU branch text', () => {
  const run = (sourceFlat: Record<string, string>, transform: (v: string) => string) =>
    translateJson({
      logger: silent,
      sourceFlat,
      from: 'en',
      to: ['es'],
      namespace: 'test',
      config,
      engine: makeEngine(transform),
    });

  test('translates the text of each plural branch and keeps the structure', async () => {
    const { translations, stats } = await run(
      { n: 'You have {count, plural, one {# message} other {# messages}}' },
      (v) => v.replace(/message/g, 'mensaje'),
    );

    assert.equal(translations.es.n, 'You have {count, plural, one {# mensaje} other {# mensajes}}');
    assert.deepEqual(stats.warnings, []);
  });

  test('translates a branch that opens with a variable, with no NOT_SENT', async () => {
    const { translations, stats } = await run({ n: '{count, plural, one {{count} file} other {{count} files}}' }, (v) =>
      v.replace(/file/g, 'archivo'),
    );

    assert.equal(translations.es.n, '{count, plural, one {{count} archivo} other {{count} archivos}}');
    assert.deepEqual(stats.warnings, []);
  });

  test('translates both levels of a select nested in a plural', async () => {
    const { translations } = await run(
      {
        n: '{c, plural, one {{g, select, male {He has # cat} other {She has # cat}}} other {# cats}}'.replace(
          '{{g',
          '{ {g',
        ),
      },
      (v) =>
        v
          .replace(/cat/g, 'gato')
          .replace(/He has/g, 'Él tiene')
          .replace(/She has/g, 'Ella tiene'),
    );

    assert.equal(
      translations.es.n,
      '{c, plural, one { {g, select, male {Él tiene # gato} other {Ella tiene # gato}}} other {# gatos}}',
    );
  });

  test('rejects an answer that drops one selector sentinel', async () => {
    const { translations, stats } = await run({ n: '{c, plural, one {# cat} other {# cats}}' }, (v) =>
      v.replace('⟦2⟧', ''),
    );

    assert.equal(translations.es.n, undefined);
    assert.deepEqual(
      stats.warnings.map((w) => w.code),
      ['PLACEHOLDER_MISMATCH'],
    );
  });
});

describe('translateJson — a malformed ICU value', () => {
  const UNBALANCED = '{g, select, male {he} other {they}} bought {n, plural, one {# item} other {# items}';

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
      stats.warnings.some((w) => w.message.includes('"bought"')),
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

    assert.equal(updatedHashStore.fr.greeting, hashValue('Hello'));
    assert.ok(!('bought' in updatedHashStore.fr));
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
    assert.ok(stats.warnings.some((w) => w.message.includes('"bought"')));
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
    assert.ok(stats.warnings.some((w) => w.message.includes('Invalid placeholder pattern')));
  });
});
