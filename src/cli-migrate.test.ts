import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { main } from './cli.js';
import { parseMigrateArgs, runMigrate } from './cli-migrate.js';
import { EXIT_CODES, LoquiError } from './errors.js';
import { hashValue } from './hasher.js';
import { translate } from './lib.js';
import { loadTranslationMemory, memoryKey } from './translation-memory.js';
import type { EngineAdapter } from './types.js';

let root: string;
let counter = 0;

before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loqui-migrate-'));
});

after(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

/** A directory of its own, which also keeps a stray `.loqui.json` from the working tree out of the run. */
function project(): {
  dir: string;
  file: (name: string) => string;
  write: (name: string, doc: unknown) => string;
  read: (name: string) => unknown;
} {
  const dir = path.join(root, `p-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = (name: string) => path.join(dir, name);
  return {
    dir,
    file,
    write: (name, doc) => {
      fs.writeFileSync(file(name), JSON.stringify(doc), 'utf-8');
      return file(name);
    },
    read: (name) => JSON.parse(fs.readFileSync(file(name), 'utf-8')),
  };
}

function migrate(dir: string, ...tokens: string[]): string {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  runMigrate([...tokens, '--config', dir], stdout);
  return chunks.join('');
}

function usageError(code: string): (err: unknown) => boolean {
  return (err) => err instanceof LoquiError && err.code === code;
}

describe('loqui migrate — hash sidecars', () => {
  test('converts a v2 sidecar shared by two inputs, and the next run sees what changed', async () => {
    const p = project();
    const a = p.write('a.json', { k1: 'one' });
    const b = p.write('b.json', { k2: 'two' });
    p.write('h.json', { k1: hashValue('one'), k2: hashValue('two') });
    p.write('b-pt.json', { k2: 'old' });

    const out = migrate(p.dir, '--to', 'es,pt', '--input', a, '--input', b, '--hash-file', p.file('h.json'));

    const both = { k1: hashValue('one'), k2: hashValue('two') };
    assert.deepEqual(p.read('h.json'), { es: both, pt: both, $owners: { 'a.json': ['k1'], 'b.json': ['k2'] } });
    assert.match(out, /h\.json: converted 2 key\(s\) to es, pt for 2 input\(s\)/);

    p.write('b.json', { k2: 'two edited' });
    let calls = 0;
    const engine: EngineAdapter = {
      async translateChunk({ chunk, targetLocales }) {
        calls++;
        return Object.fromEntries(
          targetLocales.map((locale) => [
            locale,
            { keys: Object.fromEntries(Object.entries(chunk.keys).map(([k, v]) => [k, `${locale}:${v}`])) },
          ]),
        );
      },
    };
    await translate({
      input: b,
      from: 'en',
      to: ['pt'],
      output: p.file('b-{locale}.json'),
      hashFile: p.file('h.json'),
      configPath: p.dir,
      engine,
    });
    assert.equal(calls, 1);
    assert.deepEqual(p.read('b-pt.json'), { k2: 'pt:two edited' });
  });

  test('a sidecar that is already v3 is left as it is', () => {
    const p = project();
    const a = p.write('a.json', { k1: 'one' });
    const v3 = { es: { k1: 'h' }, $owners: { 'a.json': ['k1'] } };
    p.write('h.json', v3);
    const before = fs.readFileSync(p.file('h.json'), 'utf-8');

    const out = migrate(p.dir, '--to', 'es', a, '--hash-file', p.file('h.json'));

    assert.equal(fs.readFileSync(p.file('h.json'), 'utf-8'), before);
    assert.match(out, /already v3, unchanged/);
  });

  test('a default sidecar that does not exist is skipped, not created', () => {
    const p = project();
    const a = p.write('a.json', { k1: 'one' });

    const out = migrate(p.dir, '--to=es', `--input=${a}`);

    assert.match(out, /not found, skipped/);
    assert.equal(fs.existsSync(p.file('.a.loqui-hash.json')), false);
  });
});

describe('loqui migrate — translation memory', () => {
  test('moves an entry to its memoryKey and drops one whose string is in no input', () => {
    const p = project();
    const a = p.write('a.json', { greeting: 'Hello' });
    p.write('.a.loqui-tm.json', {
      [hashValue('Hello')]: { es: 'Hola', pt: 'Olá' },
      [hashValue('Gone')]: { es: 'Ido' },
    });

    const out = migrate(p.dir, '--to', 'es,pt', a);

    assert.deepEqual(p.read('.a.loqui-tm.json'), { [memoryKey('Hello', 'greeting')]: { es: 'Hola', pt: 'Olá' } });
    assert.match(out, /converted 1 entry, dropped 1 whose string is in none of the inputs/);
  });

  test('fans one v2 entry out to a key per parent the string sits under, and the file then loads', () => {
    const p = project();
    const a = p.write('a.json', { buttons: { save: 'Save' }, menu: { save: 'Save' }, top: 'Save' });
    p.write('.a.loqui-tm.json', { [hashValue('Save')]: { es: 'Guardar' } });

    migrate(p.dir, '--to', 'es', a);

    const { memory: migrated } = loadTranslationMemory(p.file('.a.loqui-tm.json'));
    assert.deepEqual(
      Object.keys(migrated).sort(),
      [memoryKey('Save', 'buttons.save'), memoryKey('Save', 'menu.save'), memoryKey('Save', 'top')].sort(),
    );
  });

  test('keeps the owners a file already lists, and does not take `$owners` for a v2 entry', () => {
    const p = project();
    const a = p.write('a.json', { x: 'Alpha' });
    const owners = { 'a.json': [memoryKey('Alpha', 'x')] };
    p.write('.a.loqui-tm.json', { $owners: owners, [hashValue('Alpha')]: { es: 'A' } });

    migrate(p.dir, '--to', 'es', a);

    const migrated = p.read('.a.loqui-tm.json') as Record<string, unknown>;
    assert.deepEqual(migrated.$owners, owners);
    assert.deepEqual(migrated[memoryKey('Alpha', 'x')], { es: 'A' });
  });

  test('converts each input default memory file in one run, without a flag', () => {
    const p = project();
    const a = p.write('a.json', { x: 'Alpha' });
    const b = p.write('b.json', { y: 'Beta' });
    p.write('.a.loqui-tm.json', { [hashValue('Alpha')]: { es: 'A' } });
    p.write('.b.loqui-tm.json', { [hashValue('Beta')]: { es: 'B' } });

    migrate(p.dir, '--to', 'es', a, b);

    assert.deepEqual(p.read('.a.loqui-tm.json'), { [memoryKey('Alpha', 'x')]: { es: 'A' } });
    assert.deepEqual(p.read('.b.loqui-tm.json'), { [memoryKey('Beta', 'y')]: { es: 'B' } });
  });

  test('an explicit memory file overrides the default, and an existing v3 entry wins a locale', () => {
    const p = project();
    const a = p.write('a.json', { x: 'Alpha' });
    p.write('tm.json', {
      [hashValue('Alpha')]: { es: 'old', pt: 'velho' },
      [memoryKey('Alpha', 'x')]: { es: 'new' },
    });

    migrate(p.dir, '--to', 'es', a, '--translation-memory-file', p.file('tm.json'));

    assert.deepEqual(p.read('tm.json'), { [memoryKey('Alpha', 'x')]: { es: 'new', pt: 'velho' } });
  });

  test('a memory file that is already v3 is left as it is', () => {
    const p = project();
    const a = p.write('a.json', { x: 'Alpha' });
    p.write('.a.loqui-tm.json', { [memoryKey('Alpha', 'x')]: { es: 'A' } });
    const before = fs.readFileSync(p.file('.a.loqui-tm.json'), 'utf-8');

    const out = migrate(p.dir, '--to', 'es', a);

    assert.equal(fs.readFileSync(p.file('.a.loqui-tm.json'), 'utf-8'), before);
    assert.match(out, /already v3, unchanged/);
  });
});

describe('loqui migrate — usage', () => {
  test('rejects a run with no --to and no config to', () => {
    const p = project();
    const a = p.write('a.json', { x: 'Alpha' });
    assert.throws(() => migrate(p.dir, a), usageError('INVALID_USAGE'));
  });

  test('rejects a run with no input', () => {
    const p = project();
    assert.throws(() => migrate(p.dir, '--to', 'es'), usageError('INVALID_USAGE'));
  });

  test('reads an inline JSON string as a path, so it is not found', () => {
    const p = project();
    assert.throws(() => migrate(p.dir, '--to', 'es', '--input', '{"a":"b"}'), usageError('INPUT_NOT_FOUND'));
  });

  test('rejects an unknown flag and a flag with no value', () => {
    assert.throws(() => parseMigrateArgs(['--hash-fil', 'h.json']), usageError('INVALID_USAGE'));
    assert.throws(() => parseMigrateArgs(['--to']), usageError('INVALID_USAGE'));
    assert.throws(() => parseMigrateArgs(['--to', '--input', 'a.json']), usageError('INVALID_USAGE'));
  });

  test('is reachable as a subcommand, and `loqui --help` lists it', async () => {
    const real = process.argv;
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    try {
      process.argv = ['node', 'loqui', '--help'];
      await main({ stdout });
      assert.match(chunks.join(''), /loqui migrate \[options\] {7}Convert v2 hash sidecars/);

      chunks.length = 0;
      process.argv = ['node', 'loqui', 'migrate', '--help'];
      await main({ stdout });
      assert.match(chunks.join(''), /loqui migrate/);
    } finally {
      process.argv = real;
    }
  });
});

describe('the CLI on a v2 sidecar', () => {
  test('exits 9 naming loqui migrate, and writes nothing', async () => {
    const p = project();
    const a = p.write('a.json', { k1: 'one' });
    p.write('h.json', { k1: hashValue('one') });
    const real = process.argv;
    const realErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      process.argv = [
        'node',
        'loqui',
        ...['--input', a, '--from', 'en', '--to', 'es', '--output', p.file('{locale}.json')],
        ...['--hash-file', p.file('h.json'), '--config', p.dir],
      ];
      await assert.rejects(
        main(),
        (err: unknown) =>
          err instanceof LoquiError && EXIT_CODES[err.code] === 9 && err.message.includes('loqui migrate'),
      );
    } finally {
      process.argv = real;
      process.stderr.write = realErr;
    }
    assert.equal(fs.existsSync(p.file('es.json')), false);
    assert.deepEqual(p.read('h.json'), { k1: hashValue('one') });
  });
});

describe('a v2 translation-memory file', () => {
  const engine: EngineAdapter = {
    async translateChunk() {
      throw new Error('a refused run must not reach the engine');
    },
  };

  test('is refused by translate() and the CLI, and left untouched', async () => {
    const p = project();
    const a = p.write('a.json', { k1: 'one' });
    const tm = p.write('tm.json', { [hashValue('one')]: { es: 'uno' } });
    const before = fs.readFileSync(tm, 'utf-8');
    const refused = (err: unknown) =>
      err instanceof LoquiError &&
      err.code === 'INVALID_CONFIG' &&
      EXIT_CODES[err.code] === 9 &&
      err.message.includes('loqui migrate');

    await assert.rejects(
      translate({
        input: a,
        from: 'en',
        to: ['es'],
        output: p.file('{locale}.json'),
        translationMemory: true,
        translationMemoryFile: tm,
        configPath: p.dir,
        engine,
      }),
      refused,
    );

    const real = process.argv;
    const realErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      process.argv = [
        'node',
        'loqui',
        ...['--input', a, '--from', 'en', '--to', 'es', '--output', p.file('{locale}.json')],
        ...['--translation-memory-file', tm, '--config', p.dir],
      ];
      await assert.rejects(main(), refused);
    } finally {
      process.argv = real;
      process.stderr.write = realErr;
    }

    assert.equal(fs.readFileSync(tm, 'utf-8'), before);
    assert.equal(fs.existsSync(p.file('es.json')), false);
  });
});
