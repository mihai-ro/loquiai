import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hashValue, readSidecar } from './hasher.js';
import { translate } from './lib.js';
import type { EngineAdapter, TranslateChunkRequest, TranslationResult } from './types.js';

let tmpDir: string;
let counter = 0;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-cap-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Answers every key without its placeholder, so each one is turned down. Counts the keys it was sent. */
function brokenEngine(): EngineAdapter & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async translateChunk({ chunk, targetLocales }: TranslateChunkRequest): Promise<Record<string, TranslationResult>> {
      sent.push(...Object.keys(chunk.keys));
      return Object.fromEntries(targetLocales.map((locale) => [locale, { keys: mapValues(chunk.keys, () => 'sin') }]));
    },
  };
}

/** Answers every key in good order. */
function goodEngine(): EngineAdapter & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async translateChunk({ chunk, targetLocales }: TranslateChunkRequest): Promise<Record<string, TranslationResult>> {
      sent.push(...Object.keys(chunk.keys));
      return Object.fromEntries(
        targetLocales.map((locale) => [locale, { keys: mapValues(chunk.keys, (value) => value.toUpperCase()) }]),
      );
    },
  };
}

function mapValues(keys: Record<string, string>, fn: (value: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, fn(value)]));
}

/** A directory with `en.json`, a hash sidecar and an output template. */
function project(source: Record<string, string>, name = 'en.json') {
  const dir = path.join(tmpDir, `p${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, name);
  const hashFile = path.join(dir, 'hash.json');
  fs.writeFileSync(input, JSON.stringify(source));
  const run = (engine: EngineAdapter, extra: { force?: boolean } = {}) =>
    translate({
      input,
      from: 'en',
      to: ['es'],
      output: path.join(dir, '{locale}.json'),
      hashFile,
      engine,
      ...extra,
    });
  return {
    dir,
    input,
    hashFile,
    run,
    edit: (doc: Record<string, string>) => fs.writeFileSync(input, JSON.stringify(doc)),
    attempts: () => readSidecar(hashFile).attempts,
  };
}

const capWarnings = (result: Awaited<ReturnType<typeof translate>>) =>
  result.stats.warnings.filter((w) => w.code === 'RETRY_CAP');

describe('retry cap — a key turned down on every run', () => {
  test('is sent on runs 1-3, withheld on run 4 with a warning, and sent again once its source changes', async () => {
    const p = project({ greeting: 'Hello {name}' });
    const engine = brokenEngine();

    for (let run = 1; run <= 3; run++) {
      const result = await p.run(engine);
      assert.equal(engine.sent.length, run, `run ${run} sends the key`);
      assert.equal(capWarnings(result).length, 0);
    }

    const fourth = await p.run(engine);
    assert.equal(engine.sent.length, 3, 'run 4 sends no request for it');
    assert.equal(fourth.stats.apiRequests, 0);
    assert.deepEqual(
      capWarnings(fourth).map((w) => [w.locale, w.key]),
      [['es', 'greeting']],
    );

    p.edit({ greeting: 'Hello again {name}' });
    await p.run(engine);
    assert.equal(engine.sent.length, 4, 'run 5 sends it again for the new source');
    assert.equal(p.attempts()[path.basename(p.input)].es.greeting.n, 1, 'and the count starts over');
  });

  test('a key blanked in the target while the sidecar holds its hash stays withheld after the cap', async () => {
    const p = project({ greeting: 'Hello {name}' });
    await p.run(goodEngine());
    fs.writeFileSync(path.join(p.dir, 'es.json'), JSON.stringify({ greeting: '' }));

    const engine = brokenEngine();
    const requests: number[] = [];
    const warned: number[] = [];
    for (let run = 1; run <= 8; run++) {
      const before = engine.sent.length;
      const result = await p.run(engine);
      requests.push(engine.sent.length - before);
      warned.push(capWarnings(result).length);
    }

    assert.deepEqual(requests, [1, 1, 1, 0, 0, 0, 0, 0]);
    assert.deepEqual(warned, [0, 0, 0, 1, 1, 1, 1, 1], 'each run after the third logs RETRY_CAP');
  });

  test('a key the engine always answers with nothing is capped like any other', async () => {
    const p = project({ k: 'Hello' });
    const sent: string[] = [];
    // What the engines make of a key the model left out of its answer: an empty string.
    const leavesOut: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        sent.push(...Object.keys(chunk.keys));
        return Object.fromEntries(targetLocales.map((locale) => [locale, { keys: mapValues(chunk.keys, () => '') }]));
      },
    };

    const requests: number[] = [];
    const warned: number[] = [];
    for (let run = 1; run <= 5; run++) {
      const before = sent.length;
      const result = await p.run(leavesOut);
      requests.push(sent.length - before);
      warned.push(capWarnings(result).length);
    }

    assert.deepEqual(requests, [1, 1, 1, 0, 0]);
    assert.deepEqual(warned, [0, 0, 0, 1, 1], 'runs 4 and 5 log RETRY_CAP');
  });

  test('--force sends a capped key', async () => {
    const p = project({ greeting: 'Hello {name}' });
    const engine = brokenEngine();
    for (let run = 0; run < 3; run++) await p.run(engine);
    await p.run(engine);
    assert.equal(engine.sent.length, 3);

    const forced = await p.run(engine, { force: true });

    assert.equal(engine.sent.length, 4);
    assert.equal(capWarnings(forced).length, 0);
  });

  test('a capped key stays owed: its source hash is not recorded', async () => {
    const p = project({ greeting: 'Hello {name}' });
    const engine = brokenEngine();
    for (let run = 0; run < 4; run++) await p.run(engine);

    assert.equal(Object.hasOwn(readSidecar(p.hashFile).locales.es ?? {}, 'greeting'), false);
  });

  test('a key that is accepted later has no entry left', async () => {
    const p = project({ greeting: 'Hello {name}', other: 'Fine' });
    await p.run(brokenEngine());
    assert.equal(p.attempts()['en.json'].es.greeting.n, 1);

    await p.run(goodEngine());

    assert.deepEqual(p.attempts(), {});
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(p.hashFile, 'utf-8')), '$attempts'), false);
  });

  test('a key removed from the source leaves no entry', async () => {
    const p = project({ greeting: 'Hello {name}', other: 'Fine' });
    await p.run(brokenEngine());
    assert.equal(Object.hasOwn(p.attempts()['en.json'].es, 'greeting'), true);

    p.edit({ other: 'Fine' });
    await p.run(goodEngine());

    assert.deepEqual(p.attempts(), {});
  });

  test('a shared sidecar keeps another input’s counts', async () => {
    const a = project({ greeting: 'Hello {name}' }, 'a.json');
    const b = path.join(a.dir, 'b.json');
    fs.writeFileSync(b, JSON.stringify({ farewell: 'Bye {name}' }));
    const engine = brokenEngine();
    await a.run(engine);

    await translate({
      input: b,
      from: 'en',
      to: ['es'],
      output: path.join(a.dir, 'b-{locale}.json'),
      hashFile: a.hashFile,
      engine,
    });

    const attempts = a.attempts();
    assert.equal(attempts['a.json'].es.greeting.n, 1);
    assert.equal(attempts['b.json'].es.farewell.n, 1);
    assert.equal(attempts['a.json'].es.greeting.hash, hashValue('Hello {name}'));
  });

  test('a run without a sidecar has nothing to count, so it never withholds', async () => {
    const p = project({ greeting: 'Hello {name}' });
    const engine = brokenEngine();

    for (let run = 0; run < 5; run++) {
      await translate({ input: p.input, from: 'en', to: ['es'], output: path.join(p.dir, '{locale}.json'), engine });
    }

    assert.equal(engine.sent.length, 5);
  });

  test('a key left out of a run keeps its count when a failure leaves its locale unwritten', async () => {
    const p = project({ greeting: 'Hello {name}' });
    await p.run(brokenEngine());
    const failing: EngineAdapter = {
      async translateChunk() {
        throw new Error('boom');
      },
    };

    await assert.rejects(p.run(failing));

    assert.equal(p.attempts()['en.json'].es.greeting.n, 1);
  });
});

describe('the sidecar’s $attempts', () => {
  test('entries of the wrong shape are ignored, and a prototype key stays a plain key', () => {
    const file = path.join(tmpDir, 'odd-hash.json');
    fs.writeFileSync(
      file,
      '{"$owners":{},"$attempts":{"a.json":{"es":{"k":{"hash":"abc","n":2},"bad":{"hash":1,"n":"x"},"none":null}},"__proto__":{"es":{"k":{"hash":"h","n":1}}},"list":[]}}',
    );

    const { attempts } = readSidecar(file);

    assert.deepEqual(attempts['a.json'], { es: { k: { hash: 'abc', n: 2 } } });
    assert.equal(Object.hasOwn(attempts, '__proto__'), true);
    assert.equal(({} as Record<string, unknown>).es, undefined, 'Object.prototype is untouched');
    assert.equal(Object.hasOwn(attempts, 'list'), false);
  });
});
