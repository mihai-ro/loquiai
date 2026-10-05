import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { LoquiError } from './errors.js';
import { hashValue } from './hasher.js';
import { translateObject } from './translate-object.js';
import { memoryKey } from './translation-memory.js';
import type { EngineAdapter, TranslationChunk, TranslationMemory, TranslationResult } from './types.js';

/** Uppercases every value, per locale. `onCall` sees each chunk before it is answered. */
function makeEngine(onCall: (chunk: TranslationChunk, glossaryBlock?: string) => void = () => {}): EngineAdapter {
  return {
    async translateChunk({ chunk, targetLocales, glossaryBlock }) {
      onCall(chunk, glossaryBlock);
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

describe('translateObject — no disk', () => {
  test('resolves with documents, hashes, memory, stats and removed, and leaves the working directory empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-core-'));
    // A config file the core must never look at: it would be rejected if it were read.
    fs.writeFileSync(path.join(dir, '.loqui.json'), '{"engine":"not-an-engine"}', 'utf-8');
    const before = fs.readdirSync(dir).sort();
    const realCwd = process.cwd();
    process.chdir(dir);
    try {
      const run = await translateObject(
        { a: 'Hello', nested: { b: 'World' } },
        { from: 'en', to: ['es'], engine: makeEngine() },
      );

      assert.deepEqual(run.locales.es, { a: 'HELLO', nested: { b: 'WORLD' } });
      assert.equal(run.stats.keysTranslated, 2);
      assert.deepEqual(run.removed, { es: [] });
      assert.deepEqual(run.hashes, { es: { a: hashValue('Hello'), 'nested.b': hashValue('World') } });
      assert.deepEqual(run.memory[memoryKey('Hello')], { es: 'HELLO' });
      assert.equal(typeof run.locales.es, 'object');
    } finally {
      process.chdir(realCwd);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'the core wrote or created something');
    fs.rmSync(dir, { recursive: true });
  });

  test('writes nothing to stdout or stderr when it has no logger', async () => {
    const seen: string[] = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const spy =
      (stream: NodeJS.WriteStream, real: typeof process.stdout.write) =>
      (chunk: string | Uint8Array, ...rest: unknown[]) => {
        seen.push(String(chunk));
        return (real as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
      };
    process.stdout.write = spy(process.stdout, realOut) as typeof process.stdout.write;
    process.stderr.write = spy(process.stderr, realErr) as typeof process.stderr.write;
    try {
      await translateObject({ a: 'Hello' }, { from: 'en', to: ['es'], namespace: 'core-silent', engine: makeEngine() });
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }

    assert.ok(!seen.some((chunk) => chunk.includes('core-silent')), 'the core printed its progress');
  });
});

describe('translateObject — documents', () => {
  test('have sorted keys, as the written files do', async () => {
    const run = await translateObject(
      { z: 'z', a: { y: 'y', b: 'b' } },
      { from: 'en', to: ['es'], engine: makeEngine() },
    );

    assert.deepEqual(Object.keys(run.locales.es), ['a', 'z']);
    assert.deepEqual(Object.keys(run.locales.es.a as object), ['b', 'y']);
  });

  test('carry non-string values from the source untouched', async () => {
    const run = await translateObject(
      { n: 3, ok: false, nothing: null, t: 'x' },
      { from: 'en', to: ['es'], engine: makeEngine() },
    );

    assert.deepEqual(run.locales.es, { n: 3, nothing: null, ok: false, t: 'X' });
  });

  test('one per target locale', async () => {
    const run = await translateObject({ a: 'Hello' }, { from: 'en', to: ['es', 'pt'], engine: makeEngine() });

    assert.deepEqual(Object.keys(run.locales).sort(), ['es', 'pt']);
  });
});

describe('translateObject — config', () => {
  test('is merged over the defaults and validated, and a bad value rejects with no result', async () => {
    await assert.rejects(
      translateObject({ a: 'Hello' }, { from: 'en', to: ['es'], config: { temperature: 99 }, engine: makeEngine() }),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_CONFIG' && err.result === undefined,
    );
  });

  test('a __proto__ target locale rejects instead of vanishing from the result', async () => {
    let called = false;
    await assert.rejects(
      translateObject(
        { a: 'Hello' },
        { from: 'en', to: ['es', '__proto__'], engine: makeEngine(() => (called = true)) },
      ),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_CONFIG' && err.result === undefined,
    );
    assert.equal(called, false);
  });

  test('a partial config still runs on the defaults', async () => {
    const chunks: number[] = [];
    const run = await translateObject(
      { a: 'Hello' },
      {
        from: 'en',
        to: ['es'],
        config: { concurrency: 1 },
        engine: makeEngine((chunk) => chunks.push(Object.keys(chunk.keys).length)),
      },
    );

    assert.equal(run.locales.es.a, 'HELLO');
    assert.deepEqual(chunks, [1]);
  });
});

describe('translateObject — existing documents and removed keys', () => {
  test('a key already translated is not sent again', async () => {
    const sent: string[] = [];
    const run = await translateObject(
      { a: 'Hello', b: 'World' },
      {
        from: 'en',
        to: ['es'],
        existing: { es: { a: 'Hola' } },
        engine: makeEngine((chunk) => sent.push(...Object.keys(chunk.keys))),
      },
    );

    assert.deepEqual(sent, ['b']);
    assert.deepEqual(run.locales.es, { a: 'Hola', b: 'WORLD' });
  });

  test('removed lists, per locale, the keys the source no longer has, and the run says so', async () => {
    const run = await translateObject(
      { a: 'Hello' },
      {
        from: 'en',
        to: ['es', 'pt'],
        existing: { es: { a: 'Hola', stale: 'x', old: { deep: 'y' } } },
        engine: makeEngine(),
      },
    );

    assert.deepEqual([...run.removed.es].sort(), ['old.deep', 'stale']);
    assert.deepEqual(run.removed.pt, []);
    assert.deepEqual(run.locales.es, { a: 'Hola' });
    assert.ok(run.stats.warnings.some((w) => /es\W.*Removed 2 key\(s\)/.test(w)));
  });

  test('a dry run says it would remove them', async () => {
    const run = await translateObject(
      { a: 'Hello' },
      { from: 'en', to: ['es'], existing: { es: { a: 'Hola', stale: 'x' } }, dryRun: true, engine: makeEngine() },
    );

    assert.deepEqual(run.removed.es, ['stale']);
    assert.ok(run.stats.warnings.some((w) => /Would remove 1 key\(s\)/.test(w)));
  });
});

describe('translateObject — hashes and memory', () => {
  test('hashes turn incremental on: a second run over the first one returns sends nothing', async () => {
    const first = await translateObject({ a: 'Hello' }, { from: 'en', to: ['es'], hashes: {}, engine: makeEngine() });
    let calls = 0;

    const second = await translateObject(
      { a: 'Hello' },
      { from: 'en', to: ['es'], hashes: first.hashes, existing: first.locales, engine: makeEngine(() => calls++) },
    );

    assert.equal(calls, 0);
    assert.deepEqual(second.locales.es, { a: 'HELLO' });
  });

  test('a changed source is re-translated when the hashes say it changed', async () => {
    const sent: string[] = [];

    const run = await translateObject(
      { a: 'Hello again' },
      {
        from: 'en',
        to: ['es'],
        hashes: { es: { a: hashValue('Hello') } },
        existing: { es: { a: 'HELLO' } },
        engine: makeEngine((chunk) => sent.push(...Object.keys(chunk.keys))),
      },
    );

    assert.deepEqual(sent, ['a']);
    assert.equal(run.locales.es.a, 'HELLO AGAIN');
  });

  test('memory serves a known string, and the memory handed in is not mutated', async () => {
    const memory: TranslationMemory = { [memoryKey('Hello')]: { es: 'Hola' } };
    const snapshot = JSON.parse(JSON.stringify(memory));
    let calls = 0;

    const run = await translateObject(
      { a: 'Hello', b: 'World' },
      { from: 'en', to: ['es', 'pt'], memory, engine: makeEngine(() => calls++) },
    );

    assert.equal(run.locales.es.a, 'Hola');
    assert.equal(run.memory[memoryKey('World')].pt, 'WORLD');
    assert.deepEqual(memory, snapshot, "the caller's memory object was changed");
  });
});

describe('translateObject — glossary', () => {
  test('a resolved glossary reaches the engine, and a source needs no glossary key for it', async () => {
    const blocks: string[] = [];

    await translateObject(
      { title: 'Open the Dashboard' },
      {
        from: 'en',
        to: ['es'],
        glossary: { terms: { Dashboard: { es: 'Tablero' } }, noTranslate: [] },
        engine: makeEngine((_chunk, block) => blocks.push(block ?? '')),
      },
    );

    assert.ok(blocks[0].includes('Tablero'), blocks[0]);
  });
});

describe('translateObject — a chunk failure', () => {
  const KEEP = 'kept '.repeat(400);
  const BOOM = 'lost '.repeat(400);

  /** Fails only for the keys named, so a run can be made to half-succeed. */
  function flakyEngine(failOn: string[]): EngineAdapter {
    const inner = makeEngine();
    return {
      async translateChunk(req) {
        if (Object.keys(req.chunk.keys).some((k) => failOn.includes(k))) throw new Error('API exploded');
        return inner.translateChunk(req);
      },
    };
  }

  async function rejection(promise: Promise<unknown>): Promise<LoquiError> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof LoquiError) return err;
      throw err;
    }
    assert.fail('should have rejected');
  }

  test('carries everything that landed: documents, hashes and memory', async () => {
    const err = await rejection(
      translateObject(
        { keep: KEEP, boom: BOOM },
        { from: 'en', to: ['es'], hashes: {}, memory: {}, config: { splitToken: 500 }, engine: flakyEngine(['boom']) },
      ),
    );

    assert.equal(err.code, 'CHUNK_FAILED');
    assert.ok(err.result, 'no result on the error');
    assert.equal(err.result.locales.es.keep, KEEP.toUpperCase());
    assert.equal(err.result.locales.es.boom, undefined);
    assert.ok(err.result.hashes?.es && 'keep' in err.result.hashes.es && !('boom' in err.result.hashes.es));
    assert.ok(err.result.memory && memoryKey(KEEP) in err.result.memory);
    assert.equal(err.result.stats.failedChunks, 1);
    assert.equal(err.result.written, undefined, 'the core writes nothing, so it cannot say what was written');
    assert.ok(err.cause instanceof AggregateError);
  });

  test('carries the result, with its warnings, even when nothing landed', async () => {
    const err = await rejection(
      translateObject(
        { a: 'Hello' },
        {
          from: 'en',
          to: ['es'],
          engine: {
            async translateChunk() {
              throw new LoquiError('AUTH', 'OpenAI API error 401: invalid key');
            },
          },
        },
      ),
    );

    assert.equal(err.code, 'AUTH');
    assert.equal(err.message, 'OpenAI API error 401: invalid key');
    assert.ok(err.result);
    assert.equal(err.result.stats.keysTranslated, 0);
    assert.ok(err.result.stats.warnings.length > 0, 'the warnings are what the CLI summary needs');
    assert.equal('partial' in err, false, 'partial was replaced by result');
  });
});
