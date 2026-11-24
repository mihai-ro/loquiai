import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { translate } from './lib.js';
import type { EngineAdapter, TranslateChunkRequest, TranslationResult } from './types.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-plan-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Counts what it is sent: one entry per request, and the keys each locale was sent. */
function countingEngine() {
  const requests: string[][] = [];
  const keysPerLocale: Record<string, number> = {};
  const engine: EngineAdapter = {
    async translateChunk({ chunk, targetLocales }: TranslateChunkRequest): Promise<Record<string, TranslationResult>> {
      requests.push(Object.keys(chunk.keys));
      for (const locale of targetLocales)
        keysPerLocale[locale] = (keysPerLocale[locale] ?? 0) + Object.keys(chunk.keys).length;
      return Object.fromEntries(
        targetLocales.map((locale) => [
          locale,
          { keys: Object.fromEntries(Object.entries(chunk.keys).map(([key, value]) => [key, value.toUpperCase()])) },
        ]),
      );
    },
  };
  return { engine, requests, keysPerLocale };
}

/** Enough text, and a low splitToken, that the keys do not fit one chunk. */
function fixture() {
  const doc = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`key${i}`, `Some sentence number ${i} to translate`]),
  );
  const input = path.join(tmpDir, 'en.json');
  fs.writeFileSync(input, JSON.stringify(doc));
  const dir = path.join(tmpDir, 'out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pt.json'), JSON.stringify({ key0: 'ja traduzido' }));
  return { input, output: { es: path.join(dir, 'es.json'), pt: path.join(dir, 'pt.json') } };
}

describe('dry-run plan', () => {
  test('the planned requests and per-locale keys equal what the live run then sends', async () => {
    const { input, output } = fixture();
    const options = { input, from: 'en', to: ['es', 'pt'], output, config: { splitToken: 500 } };
    const dry = countingEngine();
    const live = countingEngine();

    const planned = await translate({ ...options, dryRun: true, engine: dry.engine });
    const sent = await translate({ ...options, engine: live.engine });

    assert.ok(planned.stats.plan.requests > 1, 'the fixture spans several chunks');
    assert.equal(planned.stats.plan.requests, live.requests.length);
    assert.equal(planned.stats.plan.requests, sent.stats.apiRequests);
    assert.deepEqual(planned.stats.plan.keys, live.keysPerLocale);
    assert.deepEqual(planned.stats.plan.keys, { es: 40, pt: 39 }, 'a locale that holds a key is not sent it');
    assert.deepEqual(sent.stats.plan, planned.stats.plan, 'a live run reports its plan too');
  });

  test('a dry run makes no request, to an engine or to the network', async () => {
    const { input, output } = fixture();
    const engine = countingEngine();
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched++;
      throw new Error('a dry run must not fetch');
    }) as typeof fetch;
    try {
      await translate({ input, from: 'en', to: ['es'], output, dryRun: true, engine: engine.engine });
      await translate({ input, from: 'en', to: ['es'], output, dryRun: true, config: { engine: 'anthropic' } });
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(engine.requests.length, 0);
    assert.equal(fetched, 0);
  });

  test('a run with nothing to send plans nothing', async () => {
    const nothing = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(nothing, '{}');

    const run = await translate({
      input: nothing,
      from: 'en',
      to: ['es'],
      dryRun: true,
      engine: countingEngine().engine,
    });

    assert.deepEqual(run.stats.plan, { requests: 0, keys: {} });
  });
});
