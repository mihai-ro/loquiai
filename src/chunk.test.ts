import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chunkTranslations } from './chunk.js';
import { translateJson } from './translator.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type GlossaryModel,
  type LoquiConfig,
  type TranslateChunkRequest,
  type TranslationResult,
} from './types.js';

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

/** An engine that answers every key it is sent with `answer(masked)`. */
function answering(answer: (masked: string) => string): EngineAdapter {
  return {
    async translateChunk({ chunk, targetLocales }: TranslateChunkRequest): Promise<Record<string, TranslationResult>> {
      const keys = Object.fromEntries(Object.entries(chunk.keys).map(([key, value]) => [key, answer(value)]));
      return Object.fromEntries(targetLocales.map((locale) => [locale, { keys }]));
    },
  };
}

function runWith(
  sourceFlat: Record<string, string>,
  engine: EngineAdapter,
  config: Partial<LoquiConfig> = {},
  glossaryModel?: GlossaryModel,
) {
  return translateJson({
    logger: () => {},
    sourceFlat,
    from: 'en',
    to: ['es'],
    namespace: 'test',
    config: { ...CONFIG_DEFAULTS, ...config },
    engine,
    glossaryModel,
  });
}

describe('writeResults — a sentinel bracket left in an answer', () => {
  const source = { bold: '<b>Hi</b>' };

  for (const [name, answer] of [
    ['a stray closing bracket', '⟦0⟧Hola⟦1⟧⟧'],
    ['a lone opening bracket', '⟦0⟧Hola⟦1⟧⟦'],
  ]) {
    test(`${name} is rejected`, async () => {
      const { translations, rejected, stats } = await runWith(
        source,
        answering(() => answer),
      );

      assert.equal(translations.es.bold, undefined);
      assert.deepEqual([...rejected.es], ['bold']);
      assert.deepEqual(
        stats.warnings.map(({ code, locale, key }) => ({ code, locale, key })),
        [{ code: 'PLACEHOLDER_MISMATCH', locale: 'es', key: 'bold' }],
      );
    });
  }

  test('a correct answer is still written', async () => {
    const { translations, stats } = await runWith(
      source,
      answering(() => '⟦0⟧Hola⟦1⟧'),
    );

    assert.equal(translations.es.bold, '<b>Hola</b>');
    assert.equal(stats.warnings.length, 0);
  });
});

describe('maskChunk — noTranslate terms and placeholders', () => {
  const glossary = (...noTranslate: string[]): GlossaryModel => ({ terms: {}, noTranslate });

  /** What the model was sent, and an answer made from it by `answer`. */
  function recording(answer: (sent: string) => string) {
    const sent: string[] = [];
    const engine = answering((masked) => {
      sent.push(masked);
      return answer(masked);
    });
    return { sent, engine };
  }

  test('a term that matches a placeholder name does not strip the placeholder of its mask', async () => {
    const { sent, engine } = recording(() => 'Mejora tu plan ya');
    const { translations, rejected, stats } = await runWith(
      { upgrade: 'Upgrade your {plan} now' },
      engine,
      {},
      glossary('Plan'),
    );

    assert.match(sent[0], /^Upgrade your ⟦\d+⟧ now$/);
    assert.equal(translations.es.upgrade, undefined);
    assert.deepEqual([...rejected.es], ['upgrade']);
    assert.deepEqual(
      stats.warnings.map((w) => w.code),
      ['PLACEHOLDER_MISMATCH'],
    );
  });

  test('a term that matches an ICU header leaves the whole block masked', async () => {
    const source = '{plan, select, pro {Pro} other {Free}}';
    const { sent, engine } = recording((masked) => masked);
    const { translations } = await runWith({ tier: source }, engine, {}, glossary('Plan'));

    assert.ok(!sent[0].includes('other'), `the selector is visible to the model: ${sent[0]}`);
    assert.ok(!sent[0].includes('select'), `the header is visible to the model: ${sent[0]}`);
    assert.equal(translations.es.tier, source);
  });

  test('a numeric term does not match inside a placeholder sentinel', async () => {
    const { engine } = recording((masked) => masked.replace('item', 'artículo'));
    const { translations } = await runWith({ count: '<b>1 item</b>' }, engine, {}, glossary('1'));

    assert.equal(translations.es.count, '<b>1 artículo</b>');
  });
});

describe('writeResults — glossary terms the model could see', () => {
  const glossary: GlossaryModel = { terms: { Dashboard: { es: 'Panel' } }, noTranslate: [] };

  test('a term only inside a masked span is not required', async () => {
    const { translations, stats } = await runWith(
      { link: 'Open <a href="/dashboard">here</a>' },
      answering(() => 'Abrir ⟦0⟧aquí⟦1⟧'),
      {},
      glossary,
    );

    assert.equal(translations.es.link, 'Abrir <a href="/dashboard">aquí</a>');
    assert.equal(stats.warnings.length, 0);
  });

  test('a term in the visible text is still required', async () => {
    const { translations, stats } = await runWith(
      { open: 'Open the Dashboard' },
      answering(() => 'Abrir el tablero'),
      {},
      glossary,
    );

    assert.equal(translations.es.open, undefined);
    assert.deepEqual(
      stats.warnings.map((w) => w.code),
      ['MISSING_GLOSSARY_TERM'],
    );
  });
});
