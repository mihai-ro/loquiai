import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LoquiError } from './errors.js';
import { hashValue } from './hasher.js';
import { diff, translate } from './lib.js';
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

before(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loqui-test-'));
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('translate — the hash sidecar is kept per locale', () => {
  interface Project {
    dir: string;
    source: string;
    hashFile: string;
    out: string;
    calls: () => number;
    run: (to: string[], extra?: { output?: boolean }) => ReturnType<typeof translate>;
    edit: (doc: Record<string, string>) => void;
    read: (locale: string) => Record<string, string>;
    sidecar: () => Record<string, Record<string, string>>;
  }

  /** A project with `en.json` holding `{ greeting: 'hello' }`, a counting engine and an incremental sidecar. */
  function project(): Project {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, 'en.json');
    const hashFile = path.join(dir, 'hash.json');
    const out = path.join(dir, '{locale}.json');
    fs.writeFileSync(source, JSON.stringify({ greeting: 'hello' }));
    let calls = 0;
    const engine = makeEngine();
    const counting: EngineAdapter = {
      translateChunk: (...args) => {
        calls++;
        return engine.translateChunk(...args);
      },
    };
    return {
      dir,
      source,
      hashFile,
      out,
      calls: () => calls,
      run: (to, extra) =>
        translate({
          input: source,
          from: 'en',
          to,
          output: extra?.output === false ? undefined : out,
          hashFile,
          engine: counting,
        }),
      edit: (doc) => fs.writeFileSync(source, JSON.stringify(doc)),
      read: (locale) => JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), 'utf-8')),
      sidecar: () => JSON.parse(fs.readFileSync(hashFile, 'utf-8')),
    };
  }

  test('a source edit delivered to es is still owed to pt', async () => {
    const p = project();
    await p.run(['es', 'pt']);
    const ptBefore = p.sidecar().pt;

    p.edit({ greeting: 'hello there' });
    await p.run(['es']);
    assert.deepEqual(p.sidecar().pt, ptBefore, 'a locale outside this run keeps its entry');

    const before = p.calls();
    await p.run(['pt']);

    assert.equal(p.read('pt').greeting, 'HELLO THERE');
    assert.equal(p.calls() - before, 1);
  });

  test('an incremental run with no output leaves the sidecar alone, so the next run with output still translates', async () => {
    const p = project();
    await p.run(['es']);
    const sidecarBefore = fs.readFileSync(p.hashFile, 'utf-8');

    p.edit({ greeting: 'hello there' });
    await p.run(['es'], { output: false });
    assert.equal(fs.readFileSync(p.hashFile, 'utf-8'), sidecarBefore);

    await p.run(['es']);
    assert.equal(p.read('es').greeting, 'HELLO THERE');
  });

  test('diff() reports a key as changed for the locale that was not re-delivered', async () => {
    const p = project();
    await p.run(['es', 'pt']);
    p.edit({ greeting: 'hello there' });
    await p.run(['es']);

    const { results } = diff({ input: p.source, to: ['es', 'pt'], output: p.out, hashFile: p.hashFile });

    const byLocale = Object.fromEntries(results.map((r) => [r.locale, r]));
    assert.deepEqual(byLocale.pt.changed, ['greeting']);
    assert.deepEqual(byLocale.es.unchanged, ['greeting']);
    assert.deepEqual(byLocale.es.changed, []);
  });

  test('a v2 flat sidecar is refused by translate() and diff(), naming loqui migrate', async () => {
    const p = project();
    await p.run(['es']);
    fs.writeFileSync(p.hashFile, JSON.stringify({ greeting: hashValue('hello') }));
    fs.rmSync(path.join(p.dir, 'es.json'));
    const refused = (err: unknown) =>
      err instanceof LoquiError && err.code === 'INVALID_CONFIG' && err.message.includes('loqui migrate');

    await assert.rejects(p.run(['es']), refused);
    assert.equal(fs.existsSync(path.join(p.dir, 'es.json')), false, 'a refused run writes nothing');
    assert.throws(() => diff({ input: p.source, to: ['es'], output: p.out, hashFile: p.hashFile }), refused);
  });

  test('a dry run does not touch the sidecar', async () => {
    const p = project();
    await p.run(['es']);
    const before = fs.readFileSync(p.hashFile, 'utf-8');
    p.edit({ greeting: 'hello there' });

    await translate({
      input: p.source,
      from: 'en',
      to: ['es'],
      output: p.out,
      hashFile: p.hashFile,
      dryRun: true,
      engine: makeEngine(),
    });

    assert.equal(fs.readFileSync(p.hashFile, 'utf-8'), before);
  });
});

describe('translate — inputs sharing one hash sidecar', () => {
  function shared() {
    const dir = nextTmp();
    fs.mkdirSync(dir, { recursive: true });
    const hashFile = path.join(dir, 'shared-hash.json');
    let calls = 0;
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        calls++;
        const result: Record<string, TranslationResult> = {};
        for (const locale of targetLocales) {
          result[locale] = {
            keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, `${locale}:${v}`])),
          };
        }
        return result;
      },
    };
    const write = (name: string, doc: Record<string, string>) =>
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(doc), 'utf-8');
    const run = (name: string, to: string[] = ['es']) =>
      translate({
        input: path.join(dir, `${name}.json`),
        from: 'en',
        to,
        output: path.join(dir, `${name}-{locale}.json`),
        hashFile,
        engine,
      });
    return {
      hashFile,
      write,
      run,
      calls: () => calls,
      reset: () => {
        calls = 0;
      },
      sidecar: () => JSON.parse(fs.readFileSync(hashFile, 'utf-8')),
      target: (name: string, locale = 'es') =>
        JSON.parse(fs.readFileSync(path.join(dir, `${name}-${locale}.json`), 'utf-8')),
    };
  }

  test('a key edited in one input is retranslated after another input ran', async () => {
    const p = shared();
    p.write('a', { k1: 'one' });
    p.write('b', { k2: 'two' });
    await p.run('a');
    await p.run('b');

    p.write('a', { k1: 'one edited' });
    p.reset();
    await p.run('a');

    assert.equal(p.calls(), 1);
    assert.deepEqual(p.target('a'), { k1: 'es:one edited' });
  });

  test('a key deleted from one input leaves the other input entries in place', async () => {
    const p = shared();
    p.write('a', { k1: 'one', k3: 'three' });
    p.write('b', { k2: 'two' });
    await p.run('a');
    await p.run('b');

    p.write('a', { k1: 'one' });
    await p.run('a');

    const { es, $owners } = p.sidecar();
    assert.deepEqual(Object.keys(es).sort(), ['k1', 'k2']);
    assert.deepEqual($owners, { 'a.json': ['k1'], 'b.json': ['k2'] });
  });

  test('a sidecar with no owner list keeps the keys the source lacks', async () => {
    const p = shared();
    p.write('a', { k1: 'one' });
    await p.run('a');
    const { es } = p.sidecar();
    fs.writeFileSync(p.hashFile, JSON.stringify({ es: { ...es, other: 'deadbeef' } }), 'utf-8');

    p.write('a', { k1: 'one edited' });
    await p.run('a');

    assert.deepEqual(Object.keys(p.sidecar().es).sort(), ['k1', 'other']);
  });
});

describe('translate — a target locale starting with $', () => {
  test('is rejected, since the sidecar reserves those names', async () => {
    await assert.rejects(
      () => translate({ input: '{"greeting":"hello"}', from: 'en', to: '$x', engine: makeEngine() }),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_CONFIG',
    );
  });
});
