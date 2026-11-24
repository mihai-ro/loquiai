import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LoquiError } from './errors.js';
import { translate, translateObject } from './lib.js';
import { memoryKey } from './translation-memory.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type LoquiConfig,
  type TranslateChunkRequest,
  type TranslationResult,
} from './types.js';
import type { LogFn } from './utils/logger.js';

const _config: LoquiConfig = { ...CONFIG_DEFAULTS };
const _silent: LogFn = () => {};

let tmpDir: string;
let tmpCounter = 0;

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

function nextTmp(): string {
  return path.join(tmpDir, `test-${tmpCounter++}`);
}

/** The input file for a document: `translate()` and the CLI take paths only. */
function inputFile(json: string): string {
  const file = path.join(tmpDir, `input-${tmpCounter++}.json`);
  fs.writeFileSync(file, json);
  return file;
}

before(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loqui-test-'));
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe("translate — a target file holds exactly the source's keys", () => {
  function project(source: unknown, target: unknown): { dir: string; input: string; fr: string } {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    const fr = path.join(dir, 'fr.json');
    fs.writeFileSync(input, JSON.stringify(source), 'utf-8');
    fs.writeFileSync(fr, JSON.stringify(target), 'utf-8');
    return { dir, input, fr };
  }

  function countingEngine(): { engine: EngineAdapter; calls: () => number } {
    let calls = 0;
    const inner = makeEngine();
    return {
      engine: {
        async translateChunk(...args) {
          calls++;
          return inner.translateChunk(...args);
        },
      },
      calls: () => calls,
    };
  }

  /** What a run says through its logger, one message per line. */
  async function logOf(run: (logger: LogFn) => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    await run((_level, message) => {
      lines.push(message);
    });
    return lines.join('\n');
  }

  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

  test('a key restructured from an object to a string is translated once, then left alone', async () => {
    const { dir, input, fr } = project({ a: 'Hello' }, { a: { b: 'ancien' } });
    const { engine, calls } = countingEngine();
    const options = { input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine };

    await translate(options);
    assert.deepEqual(read(fr), { a: 'HELLO' });
    assert.equal(calls(), 1);

    await translate(options);
    assert.equal(calls(), 1, 'the second run has nothing to do');
  });

  test('an array that shrank loses its old tail', async () => {
    const { dir, input, fr } = project({ items: ['a', 'b'] }, { items: ['x', 'y', 'z'] });

    await translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine: makeEngine() });

    assert.deepEqual(read(fr), { items: ['x', 'y'] });
  });

  test('a key the source never had is removed, and the locale is told how many', async () => {
    const { dir, input, fr } = project({ a: 'Hello' }, { a: 'Bonjour', stale: 'x', old: { deep: 'y' } });

    const err = await logOf((logger) =>
      translate({
        input,
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        engine: makeEngine(),
        logger,
      }),
    );

    assert.deepEqual(read(fr), { a: 'Bonjour' });
    assert.match(err, /fr\W.*Removed 2 key\(s\)/);
    assert.match(err, /stale/);
    assert.match(err, /old\.deep/);
  });

  test('a dry run leaves the file byte-identical and says what it would remove', async () => {
    const { dir, input, fr } = project({ a: 'Hello' }, { a: 'Bonjour', stale: 'x' });
    const before = fs.readFileSync(fr, 'utf-8');

    const err = await logOf((logger) =>
      translate({
        input,
        from: 'en',
        to: ['fr'],
        output: path.join(dir, '{locale}.json'),
        dryRun: true,
        engine: makeEngine(),
        logger,
      }),
    );

    assert.equal(fs.readFileSync(fr, 'utf-8'), before);
    assert.match(err, /Would remove 1 key\(s\)/);
    assert.match(err, /stale/);
  });

  test('a run with nothing to translate still writes the pruned file', async () => {
    const { dir, input, fr } = project({ a: 'Hello' }, { a: 'Bonjour', stale: 'x' });
    const { engine, calls } = countingEngine();

    await translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine });

    assert.equal(calls(), 0);
    assert.deepEqual(read(fr), { a: 'Bonjour' });
  });

  test('a target string at a key where the source holds a number is written as the number', async () => {
    const { dir, input, fr } = project({ count: 3 }, { count: 'trois' });

    await translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine: makeEngine() });

    assert.deepEqual(read(fr), { count: 3 });
  });

  test('a null in the target does not replace a string the source now defines', async () => {
    const { dir, input, fr } = project({ title: 'Hello' }, { title: null });

    await translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine: makeEngine() });

    assert.deepEqual(read(fr), { title: 'HELLO' });
  });
});

describe('translate — a blank target means not translated yet', () => {
  function project(source: unknown, target?: unknown): { dir: string; input: string; fr: string } {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    const fr = path.join(dir, 'fr.json');
    fs.writeFileSync(input, JSON.stringify(source), 'utf-8');
    if (target !== undefined) fs.writeFileSync(fr, JSON.stringify(target), 'utf-8');
    return { dir, input, fr };
  }

  /** Uppercases, but answers nothing for keys ending in a name from `refuse`; records what it was sent. */
  function engineRefusing(refuse: string[], sent: string[]): EngineAdapter {
    return {
      async translateChunk({ chunk, targetLocales }) {
        sent.push(...Object.keys(chunk.keys));
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            {
              keys: Object.fromEntries(
                Object.entries(chunk.keys)
                  .filter(([k]) => !refuse.some((r) => k.endsWith(r)))
                  .map(([k, v]) => [k, v.toUpperCase()]),
              ),
            },
          ]),
        );
      },
    };
  }

  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
  const run = (dir: string, input: string, engine: EngineAdapter, extra: Record<string, unknown> = {}) =>
    translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine, ...extra });

  test('a target file of empty strings is translated, not reported as up to date', async () => {
    const { dir, input, fr } = project({ title: 'Hello' }, { title: '' });
    const sent: string[] = [];

    await run(dir, input, engineRefusing([], sent));

    assert.deepEqual(sent, ['title']);
    assert.deepEqual(read(fr), { title: 'HELLO' });
  });

  for (const incremental of [false, true]) {
    test(`a refused array element is written as "" and is the only thing sent next time (incremental: ${incremental})`, async () => {
      const { dir, input, fr } = project({ items: ['a', 'b', 'c'] });
      const extra = incremental ? { incremental: true } : {};

      await run(dir, input, engineRefusing(['items.1'], []), extra);
      assert.deepEqual(read(fr), { items: ['A', '', 'C'] });

      const sent: string[] = [];
      await run(dir, input, engineRefusing([], sent), extra);
      assert.deepEqual(sent, ['items.1']);
      assert.deepEqual(read(fr), { items: ['A', 'B', 'C'] });
    });
  }

  test('a refused field of an object in an array is written as ""', async () => {
    const { dir, input, fr } = project({ steps: [{ title: 'T', body: 'B' }] });

    await run(dir, input, engineRefusing(['body'], []));

    assert.deepEqual(read(fr), { steps: [{ title: 'T', body: '' }] });
  });

  test('a refused key outside any array is absent from the file', async () => {
    const { dir, input, fr } = project({ a: 'x', b: 'y' });

    await run(dir, input, engineRefusing(['b'], []));

    assert.deepEqual(read(fr), { a: 'X' });
  });

  test('an engine answer of an empty string is still rejected', async () => {
    const { dir, input, fr } = project({ items: ['a', 'b'] });
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        return Object.fromEntries(
          targetLocales.map((l) => [
            l,
            { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, k.endsWith('1') ? '' : 'DONE'])) },
          ]),
        );
      },
    };

    await run(dir, input, engine);

    assert.deepEqual(read(fr), { items: ['DONE', ''] });
  });
});

describe('translate — a corrupt file is an error, not an empty file', () => {
  const CONFLICT = '<<<<<<< HEAD\n{"a":"b"}\n=======\n{"a":"c"}\n>>>>>>> branch\n';

  function countingEngine(): { engine: EngineAdapter; calls: () => number } {
    let calls = 0;
    const inner = makeEngine();
    return {
      engine: {
        async translateChunk(...args) {
          calls++;
          return inner.translateChunk(...args);
        },
      },
      calls: () => calls,
    };
  }

  function project(): { dir: string; input: string } {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'en.json');
    fs.writeFileSync(input, JSON.stringify({ greeting: 'Hello' }), 'utf-8');
    return { dir, input };
  }

  test('a target file with a merge-conflict marker fails with PARSE_ERROR and is left alone', async () => {
    const { dir, input } = project();
    const target = path.join(dir, 'fr.json');
    fs.writeFileSync(target, CONFLICT, 'utf-8');
    const { engine, calls } = countingEngine();

    await assert.rejects(
      translate({ input, from: 'en', to: ['fr'], output: path.join(dir, '{locale}.json'), engine }),
      (err: unknown) => err instanceof LoquiError && err.code === 'PARSE_ERROR' && err.message.includes(target),
    );

    assert.equal(calls(), 0, 'nothing may be sent to a paid engine on top of a file we could not read');
    assert.equal(fs.readFileSync(target, 'utf-8'), CONFLICT);
  });

  test('a corrupt hash sidecar fails an incremental run instead of resetting change detection', async () => {
    const { dir, input } = project();
    const hashFile = path.join(dir, 'hashes.json');
    fs.writeFileSync(hashFile, CONFLICT, 'utf-8');
    const { engine, calls } = countingEngine();

    await assert.rejects(
      translate({ input, from: 'en', to: ['fr'], hashFile, engine }),
      (err: unknown) => err instanceof LoquiError && err.code === 'PARSE_ERROR' && err.message.includes(hashFile),
    );

    assert.equal(calls(), 0);
  });

  test('a corrupt hash sidecar the run does not use cannot fail it', async () => {
    const { dir, input } = project();
    fs.writeFileSync(path.join(dir, '.en.loqui-hash.json'), CONFLICT, 'utf-8');

    const result = await translate({ input, from: 'en', to: ['fr'], engine: makeEngine() });

    assert.equal(result.locales.fr.greeting, 'HELLO');
  });
});

describe('translate — the removed diff and validate modes', () => {
  for (const [flag, replacement] of [
    ['diff', 'diff()'],
    ['validate', 'validate()'],
  ] as const) {
    for (const value of [true, false]) {
      test(`${flag}: ${value} is rejected naming ${replacement}, before any file or engine is touched`, async () => {
        let engineCalls = 0;
        const engine: EngineAdapter = {
          async translateChunk() {
            engineCalls++;
            return {};
          },
        };

        await assert.rejects(
          // a v2 JavaScript caller: the file does not exist, so reading it first would fail differently
          translate({
            input: path.join(tmpDir, 'does-not-exist.json'),
            from: 'en',
            to: ['es'],
            engine,
            [flag]: value,
          } as never),
          (err: unknown) =>
            err instanceof LoquiError && err.code === 'INVALID_CONFIG' && err.message.includes(replacement),
        );

        assert.equal(engineCalls, 0);
      });
    }
  }

  test('an undefined flag is not a flag', async () => {
    const result = await translate({
      input: inputFile('{"a":"Hello"}'),
      from: 'en',
      to: ['es'],
      engine: makeEngine(),
      diff: undefined,
      validate: undefined,
    } as never);

    assert.equal(result.locales.es.a, 'HELLO');
  });
});

describe('translate — an output record must cover every target locale', () => {
  test('rejects INVALID_CONFIG naming the missing locale, before any engine call or write', async () => {
    const dir = nextTmp();
    let calls = 0;
    const engine = makeEngine();
    const counting: EngineAdapter = {
      translateChunk: (...args) => {
        calls++;
        return engine.translateChunk(...args);
      },
    };

    await assert.rejects(
      translate({
        input: inputFile('{"greeting":"hello"}'),
        from: 'en',
        to: ['es', 'de'],
        output: { es: path.join(dir, 'es.json') },
        engine: counting,
      }),
      (err: unknown) => {
        assert.ok(err instanceof LoquiError);
        assert.equal(err.code, 'INVALID_CONFIG');
        assert.match(err.message, /\bde\b/);
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(dir), false);
  });

  test('replaces every {locale} in a template', async () => {
    const dir = nextTmp();
    await translate({
      input: inputFile('{"greeting":"hello"}'),
      from: 'en',
      to: ['es'],
      output: path.join(dir, '{locale}', '{locale}.json'),
      engine: makeEngine(),
    });
    assert.equal(fs.existsSync(path.join(dir, 'es', 'es.json')), true);
  });
});

describe('translateObject — keys named like Object.prototype members', () => {
  const source = { constructor: 'Build', toString: 'Text' };

  test('a complete target is not re-sent', async () => {
    let calls = 0;
    const engine = makeEngine();
    const counting: EngineAdapter = {
      translateChunk: (...args) => {
        calls++;
        return engine.translateChunk(...args);
      },
    };
    await translateObject(source, {
      from: 'en',
      to: ['es'],
      engine: counting,
      existing: { es: { constructor: 'x', toString: 'y' } },
    });
    assert.equal(calls, 0);
  });

  test('without existing, both are translated', async () => {
    const run = await translateObject(source, { from: 'en', to: ['es'], engine: makeEngine() });
    assert.deepEqual(run.locales.es, { constructor: 'BUILD', toString: 'TEXT' });
  });
});

describe('translate — locale and term names that match Object.prototype members', () => {
  test('a glossary file with a __proto__ term does not touch Object.prototype', async () => {
    const dir = nextTmp();
    const glossaryDir = path.join(dir, 'glossary');
    fs.mkdirSync(glossaryDir, { recursive: true });
    // written as text: an object literal with a `__proto__` key would set a prototype, not a key
    fs.writeFileSync(path.join(glossaryDir, 'es.json'), '{"__proto__":"pwned"}', 'utf-8');

    try {
      const run = await translate({
        input: inputFile(JSON.stringify({ a: 'Hello' })),
        from: 'en',
        to: ['es'],
        config: { glossary: { path: glossaryDir } },
        engine: makeEngine(),
      });

      assert.equal(({} as Record<string, unknown>).es, undefined, 'Object.prototype was written to');
      assert.deepEqual(run.locales.es, { a: 'HELLO' });
    } finally {
      delete (Object.prototype as Record<string, unknown>).es;
    }
  });

  test('a locale named constructor is translated, whatever the memory holds for other locales', async () => {
    let calls = 0;
    const engine = makeEngine();
    const counting: EngineAdapter = {
      translateChunk: (...args) => {
        calls++;
        return engine.translateChunk(...args);
      },
    };

    const run = await translateObject(
      { greeting: 'Hello' },
      { from: 'en', to: ['constructor'], memory: { [memoryKey('Hello')]: { fr: 'Bonjour' } }, engine: counting },
    );

    assert.equal(calls, 1);
    assert.deepEqual(run.locales.constructor, { greeting: 'HELLO' });
  });
});
