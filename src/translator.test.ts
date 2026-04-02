import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashValue } from './hasher.js';
import { translateJson } from './translator.js';
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
