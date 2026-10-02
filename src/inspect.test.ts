import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hashValue } from './hasher.js';
import { diff, validate } from './inspect.js';

let root: string;
let counter = 0;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-inspect-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A project directory holding en.json and whichever targets are given. */
function project(source: object, targets: Record<string, object> = {}, hashes?: Record<string, string>) {
  const dir = path.join(root, `p${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, 'en.json');
  fs.writeFileSync(input, JSON.stringify(source), 'utf-8');
  for (const [locale, doc] of Object.entries(targets)) {
    fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(doc), 'utf-8');
  }
  if (hashes) fs.writeFileSync(path.join(dir, '.en.loqui-hash.json'), JSON.stringify(hashes), 'utf-8');
  return { dir, input, output: path.join(dir, '{locale}.json'), configPath: root };
}

describe('diff()', () => {
  test('reports added, removed and unchanged per locale', () => {
    const p = project({ a: 'Hello', b: 'World' }, { es: { a: 'Hola', gone: 'x' } });

    const { results } = diff({ input: p.input, to: ['es'], output: p.output, configPath: p.configPath });

    assert.equal(results.length, 1);
    assert.equal(results[0].locale, 'es');
    assert.deepEqual(results[0].added, ['b']);
    assert.deepEqual(results[0].removed, ['gone']);
  });

  test('hasBaseline is false when there is no hash sidecar and true when there is one', () => {
    const without = project({ a: 'Hello' }, { es: { a: 'Hola' } });
    const withSidecar = project({ a: 'Hello' }, { es: { a: 'Hola' } }, { a: hashValue('Hello') });

    assert.equal(diff({ input: without.input, to: 'es', output: without.output, configPath: root }).hasBaseline, false);
    assert.equal(
      diff({ input: withSidecar.input, to: 'es', output: withSidecar.output, configPath: root }).hasBaseline,
      true,
    );
  });

  test('a source that moved since the sidecar was written is reported as changed', () => {
    const p = project({ a: 'Hello again' }, { es: { a: 'Hola' } }, { a: hashValue('Hello') });

    const { results } = diff({ input: p.input, to: ['es'], output: p.output, configPath: root });

    assert.deepEqual(results[0].changed, ['a']);
  });

  test('reads the sidecar from hashFile when one is given', () => {
    const p = project({ a: 'Hello' }, { es: { a: 'Hola' } });
    const hashFile = path.join(p.dir, 'custom-hashes.json');
    fs.writeFileSync(hashFile, JSON.stringify({ a: hashValue('Hello') }), 'utf-8');

    assert.equal(diff({ input: p.input, to: ['es'], output: p.output, hashFile, configPath: root }).hasBaseline, true);
  });

  test('a corrupt sidecar fails with PARSE_ERROR', () => {
    const p = project({ a: 'Hello' }, { es: { a: 'Hola' } });
    fs.writeFileSync(path.join(p.dir, '.en.loqui-hash.json'), '<<<<<<< HEAD\n', 'utf-8');

    assert.throws(
      () => diff({ input: p.input, to: ['es'], output: p.output, configPath: root }),
      (err: unknown) => (err as { code?: string }).code === 'PARSE_ERROR',
    );
  });

  test('is synchronous', () => {
    const p = project({ a: 'Hello' });

    const report = diff({ input: p.input, to: ['es'], output: p.output, configPath: root });

    assert.ok(!(report instanceof Promise));
  });
});

describe('validate()', () => {
  test('returns a missing key under missing, an extra one under extra, the rest under ok', () => {
    const p = project({ a: 'Hello', b: 'World' }, { es: { a: 'Hola', stale: 'x' } });

    const results = validate({ input: p.input, to: ['es'], output: p.output, configPath: root });

    assert.equal(results.length, 1);
    assert.deepEqual(results[0].missing, ['b']);
    assert.deepEqual(results[0].extra, ['stale']);
    assert.deepEqual(results[0].ok, ['a']);
  });

  test('returns nothing when there are no target files', () => {
    const p = project({ a: 'Hello' });

    assert.deepEqual(validate({ input: p.input, to: ['es', 'pt'], output: p.output, configPath: root }), []);
  });

  test('does not read the hash sidecar, so a corrupt one cannot fail it', () => {
    const p = project({ a: 'Hello' }, { es: { a: 'Hola' } });
    fs.writeFileSync(path.join(p.dir, '.en.loqui-hash.json'), '<<<<<<< HEAD\n', 'utf-8');

    assert.equal(validate({ input: p.input, to: ['es'], output: p.output, configPath: root }).length, 1);
  });
});

describe('diff() and validate() — what they never do', () => {
  test('leave process.exitCode as it was, on a mismatch too', () => {
    const p = project({ a: 'Hello', b: 'World' }, { es: { a: 'Hola' } });
    const before = process.exitCode;
    try {
      process.exitCode = undefined;
      validate({ input: p.input, to: ['es'], output: p.output, configPath: root });
      diff({ input: p.input, to: ['es'], output: p.output, configPath: root });
      assert.equal(process.exitCode, undefined);

      process.exitCode = 7;
      validate({ input: p.input, to: ['es'], output: p.output, configPath: root });
      assert.equal(process.exitCode, 7);
    } finally {
      process.exitCode = before;
    }
  });

  test('write nothing to either stream and create no file', () => {
    const p = project({ a: 'Hello', b: 'World' }, { es: { a: 'Hola' } });
    const files = fs.readdirSync(p.dir).sort();
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
      validate({ input: p.input, to: ['es'], output: p.output, configPath: root });
      diff({ input: p.input, to: ['es'], output: p.output, configPath: root });
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }

    assert.ok(!seen.some((chunk) => /\[es\]|missing|Summary/.test(chunk)), 'a report line was printed');
    assert.deepEqual(fs.readdirSync(p.dir).sort(), files);
  });
});

describe('diff() and validate() — inputs', () => {
  test('need no source locale', () => {
    const p = project({ a: 'Hello' }, { es: { a: 'Hola' } });
    // no `from` anywhere: not in the options, and the config directory has no file
    assert.equal(validate({ input: p.input, to: ['es'], output: p.output, configPath: root }).length, 1);
    assert.equal(diff({ input: p.input, to: ['es'], output: p.output, configPath: root }).results.length, 1);
  });

  test('take locales as a comma-separated string, or from the config', () => {
    const p = project({ a: 'Hello' }, { es: { a: 'Hola' }, pt: { a: 'Olá' } });

    const fromString = validate({ input: p.input, to: 'es, pt', output: p.output, configPath: root });
    const fromConfig = validate({ input: p.input, output: p.output, config: { to: ['es', 'pt'] }, configPath: root });

    assert.deepEqual(
      fromString.map((r) => r.locale),
      ['es', 'pt'],
    );
    assert.deepEqual(
      fromConfig.map((r) => r.locale),
      ['es', 'pt'],
    );
  });

  test('reject a call with no locales anywhere as INVALID_CONFIG', () => {
    const p = project({ a: 'Hello' });

    assert.throws(
      () => validate({ input: p.input, output: p.output, configPath: root }),
      (err: unknown) => (err as { code?: string }).code === 'INVALID_CONFIG' && /'to'/.test((err as Error).message),
    );
  });

  test('take the output as a locale → path record, and the input as a raw JSON string', () => {
    const p = project({ a: 'Hello' }, { es: { a: 'Hola' } });

    const results = validate({
      input: '{"a":"Hello","b":"World"}',
      to: ['es'],
      output: { es: path.join(p.dir, 'es.json') },
      configPath: root,
    });

    assert.deepEqual(results[0].missing, ['b']);
  });

  test('leave an inline glossary key out of the source when the glossary is on', () => {
    const p = project({ a: 'Hello', glossary: { Hello: { es: 'Hola' } } }, { es: { a: 'Hola' } });

    const results = validate({
      input: p.input,
      to: ['es'],
      output: p.output,
      config: { glossary: {} },
      configPath: root,
    });

    assert.deepEqual(results[0].missing, []);
  });

  test('a source that is not JSON fails with PARSE_ERROR', () => {
    assert.throws(
      () => validate({ input: '{not json', to: ['es'], output: {}, configPath: root }),
      (err: unknown) => (err as { code?: string }).code === 'PARSE_ERROR',
    );
  });
});
