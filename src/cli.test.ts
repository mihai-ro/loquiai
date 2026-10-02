import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { type InputStream, main, parseArgs, readStdin, run, runInit } from './cli.js';
import { LoquiError } from './errors.js';

/** parseArgs slices argv like the real process does, so fixtures carry the two leading slots. */
function argv(...args: string[]): string[] {
  return ['node', 'loqui', ...args];
}

describe('parseArgs — value flags', () => {
  test('reads every value flag', () => {
    const args = parseArgs(
      argv(
        '--input',
        'en.json',
        '--config',
        './cfg',
        '--from',
        'en',
        '--to',
        'fr,de',
        '--engine',
        'openai',
        '--model',
        'gpt-5',
        '--context',
        'a webshop',
        '--output',
        './i18n/{locale}.json',
        '--namespace',
        'checkout',
        '--hash-file',
        './h.json',
        '--translation-memory-file',
        './tm.json',
      ),
    );

    assert.equal(args.input, 'en.json');
    assert.equal(args.config, './cfg');
    assert.equal(args.from, 'en');
    assert.equal(args.to, 'fr,de');
    assert.equal(args.engine, 'openai');
    assert.equal(args.model, 'gpt-5');
    assert.equal(args.context, 'a webshop');
    assert.equal(args.output, './i18n/{locale}.json');
    assert.equal(args.namespace, 'checkout');
    assert.equal(args.hashFile, './h.json');
    assert.equal(args.translationMemoryFile, './tm.json');
  });

  test('a value flag with no following token is rejected, naming the flag', () => {
    assert.throws(
      () => parseArgs(argv('--from')),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_USAGE' && err.message.includes('--from'),
    );
  });

  test('does not consume the next flag as a positional', () => {
    const args = parseArgs(argv('--from', 'en', '--dry-run'));
    assert.equal(args.from, 'en');
    assert.equal(args.dryRun, true);
    assert.equal(args.input, null);
  });
});

describe('parseArgs — boolean flags', () => {
  test('all booleans default to false', () => {
    const args = parseArgs(argv());
    assert.deepEqual(
      {
        incremental: args.incremental,
        translationMemory: args.translationMemory,
        dryRun: args.dryRun,
        diff: args.diff,
        validate: args.validate,
        force: args.force,
        help: args.help,
      },
      {
        incremental: false,
        translationMemory: false,
        dryRun: false,
        diff: false,
        validate: false,
        force: false,
        help: false,
      },
    );
  });

  test('sets each boolean when present', () => {
    const args = parseArgs(
      argv('--incremental', '--translation-memory', '--dry-run', '--diff', '--validate', '--force'),
    );
    assert.equal(args.incremental, true);
    assert.equal(args.translationMemory, true);
    assert.equal(args.dryRun, true);
    assert.equal(args.diff, true);
    assert.equal(args.validate, true);
    assert.equal(args.force, true);
  });

  test('accepts --help and the -h alias', () => {
    assert.equal(parseArgs(argv('--help')).help, true);
    assert.equal(parseArgs(argv('-h')).help, true);
  });
});

describe('parseArgs — input resolution', () => {
  test('falls back to the first positional argument', () => {
    assert.equal(parseArgs(argv('{"a":"b"}', '--from', 'en')).input, '{"a":"b"}');
  });

  test('a positional beside --input is rejected, naming it, rather than dropped', () => {
    assert.throws(
      () => parseArgs(argv('positional.json', '--input', 'flag.json')),
      (err: unknown) =>
        err instanceof LoquiError && err.code === 'INVALID_USAGE' && err.message.includes('positional.json'),
    );
  });

  test('--input with a trailing locale names the locale', () => {
    assert.throws(
      () => parseArgs(argv('--input', 'en.json', '--to', 'fr', 'de')),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_USAGE' && err.message.includes('de'),
    );
  });

  test('--input= is the same flag as --input', () => {
    assert.throws(() => parseArgs(argv('--input=en.json', 'de')), LoquiError);
  });

  test('input is null when nothing is supplied', () => {
    assert.equal(parseArgs(argv()).input, null);
  });
});

interface Streams {
  out: string;
  err: string;
}

/**
 * Runs the CLI with an injected stdout and captures stderr.
 *
 * stdout is injected rather than stubbed on `process`: the test reporter writes to
 * the real process.stdout, and swapping its `write` out from under it corrupts the
 * reporter's stream. stderr is free — the reporters here write to stdout or a file.
 */
async function captureStreams(fn: (stdout: NodeJS.WritableStream) => Promise<void>): Promise<Streams> {
  const out = sink();
  const err: string[] = [];
  const realErr = process.stderr.write;
  process.stderr.write = ((c: string) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn(out);
  } finally {
    process.stderr.write = realErr;
  }
  return { out: out.text(), err: err.join('') };
}

async function withArgv(args: string[], fn: () => Promise<void>): Promise<void> {
  const real = process.argv;
  process.argv = argv(...args);
  try {
    await fn();
  } finally {
    process.argv = real;
  }
}

let tmpDir: string;

before(async () => {
  // an empty directory as --config keeps these runs independent of any .loqui.json
  // that happens to sit in the working tree
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loqui-cli-'));
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('main — stream separation', () => {
  test('--help goes to stdout with nothing on stderr', async () => {
    const streams = await captureStreams(async (stdout) => {
      await withArgv(['--help'], () => main({ stdout }));
    });

    assert.match(streams.out, /loqui — i18n translation CLI/);
    assert.match(streams.out, /Exit codes:/);
    assert.equal(streams.err, '');
  });

  test('a result run puts only parseable JSON on stdout', async () => {
    const streams = await captureStreams(async (stdout) => {
      await withArgv(
        ['{"greeting":{"hi":"Hello"}}', '--from', 'en', '--to', 'fr', '--dry-run', '--config', tmpDir],
        () => main({ stdout }),
      );
    });

    assert.doesNotThrow(() => JSON.parse(streams.out), `stdout was not valid JSON: ${JSON.stringify(streams.out)}`);
    // the banner and the dry-run notice are diagnostics — they belong on stderr
    assert.match(streams.err, /\[loqui\] i18n translator/);
    assert.match(streams.err, /Dry-run mode/);
  });

  test('multi-locale results are a single JSON document on stdout', async () => {
    const streams = await captureStreams(async (stdout) => {
      await withArgv(['{"a":"x"}', '--from', 'en', '--to', 'fr,de', '--dry-run', '--config', tmpDir], () =>
        main({ stdout }),
      );
    });

    const parsed = JSON.parse(streams.out) as Record<string, string>;
    assert.deepEqual(Object.keys(parsed).sort(), ['de', 'fr']);
  });

  test('--diff writes its report to stderr and nothing to stdout', async () => {
    // diff only reports on locales that already have a file, so give it one
    const diffDir = path.join(tmpDir, 'diff');
    fs.mkdirSync(diffDir, { recursive: true });
    fs.writeFileSync(path.join(diffDir, 'fr.json'), JSON.stringify({ a: 'ancien' }), 'utf-8');

    const streams = await captureStreams(async (stdout) => {
      await withArgv(
        [
          '{"a":"x"}',
          '--from',
          'en',
          '--to',
          'fr',
          '--diff',
          '--output',
          path.join(diffDir, '{locale}.json'),
          '--config',
          tmpDir,
        ],
        () => main({ stdout }),
      );
    });

    assert.equal(streams.out, '');
    assert.match(streams.err, /\[fr\]/);
    assert.match(streams.err, /Summary:/);
  });

  test('--validate with no existing locale files warns on stderr only', async () => {
    const streams = await captureStreams(async (stdout) => {
      await withArgv(['{"a":"x"}', '--from', 'en', '--to', 'fr', '--validate', '--config', tmpDir], () =>
        main({ stdout }),
      );
    });

    assert.equal(streams.out, '');
    assert.match(streams.err, /No existing translation files found to validate/);
  });

  test('--output reports success on stderr instead of dumping JSON', async () => {
    const outDir = path.join(tmpDir, 'out');
    const streams = await captureStreams(async (stdout) => {
      await withArgv(
        [
          '{"a":"x"}',
          '--from',
          'en',
          '--to',
          'fr',
          '--dry-run',
          '--output',
          path.join(outDir, '{locale}.json'),
          '--config',
          tmpDir,
        ],
        () => main({ stdout }),
      );
    });

    assert.equal(streams.out, '');
    assert.match(streams.err, /Done\. Wrote 1 locale file\(s\)/);
  });
});

describe('run — exit code mapping', () => {
  test('maps a LoquiError to its documented exit code', async () => {
    const realExit = process.exit;
    let observed: number | undefined;
    process.exit = ((code?: number) => {
      observed = code;
      return undefined as never;
    }) as typeof process.exit;

    let err = '';
    const realErrWrite = process.stderr.write;
    process.stderr.write = ((c: string) => {
      err += String(c);
      return true;
    }) as typeof process.stderr.write;

    try {
      // no 'to' locale anywhere → INVALID_CONFIG → exit 9
      process.argv = argv('{"a":"x"}', '--from', 'en', '--config', tmpDir);
      run();
      // let the rejection handler settle
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.exit = realExit;
      process.stderr.write = realErrWrite;
    }

    assert.equal(observed, 9);
    assert.match(err, /target locale/);
  });
});

/** A stream that stands in for stdin, with the TTY flag the CLI branches on. */
function fakeStdin(chunks: string[], { isTTY = false }: { isTTY?: boolean } = {}): InputStream {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
  stream.isTTY = isTTY;
  queueMicrotask(() => {
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  return stream as InputStream;
}

/** Collects everything written to a stream, for asserting on wizard output. */
function sink(): NodeJS.WritableStream & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return Object.assign(stream, { text: () => chunks.join('') });
}

/** readline only sees a line while a question is pending, so a prompt looks like `…: ` or `…] `. */
const PROMPT = /[:\]] $/;

/**
 * Drives the interactive wizard: each answer is written only once its prompt has
 * been printed. Queueing them up front would lose every line but the first,
 * because readline discards input that arrives between questions.
 */
function wizardIO(answers: string[]): { input: InputStream; output: NodeJS.WritableStream; text: () => string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const queue = [...answers];
  const chunks: string[] = [];

  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk);
      chunks.push(text);
      if (PROMPT.test(text)) {
        const next = queue.shift();
        if (next !== undefined) setImmediate(() => input.write(next));
      }
      callback();
    },
  });

  return { input: input as InputStream, output, text: () => chunks.join('') };
}

describe('readStdin', () => {
  test('resolves with the trimmed stream contents', async () => {
    assert.equal(await readStdin(fakeStdin(['  {"a":', '"b"}  \n'])), '{"a":"b"}');
  });

  test('rejects when the stream errors', async () => {
    const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
    const pending = readStdin(stream as InputStream);
    stream.destroy(new Error('pipe broke'));
    await assert.rejects(pending, /pipe broke/);
  });
});

describe('main — stdin input', () => {
  test('reads the source document from stdin when no input flag is given', async () => {
    const streams = await captureStreams(async (stdout) => {
      await withArgv(['--from', 'en', '--to', 'fr', '--dry-run', '--config', tmpDir], () =>
        main({ stdin: fakeStdin(['{"a":"x"}']), stdout }),
      );
    });

    assert.doesNotThrow(() => JSON.parse(streams.out));
  });

  test('rejects with INVALID_USAGE when stdin is a terminal and no input was supplied', async () => {
    await assert.rejects(
      withArgv(['--from', 'en', '--to', 'fr', '--config', tmpDir], () =>
        main({ stdin: fakeStdin([], { isTTY: true }) }),
      ),
      (err: unknown) =>
        err instanceof LoquiError && err.code === 'INVALID_USAGE' && /No input provided/.test(err.message),
    );
  });

  test('rejects with INVALID_USAGE when stdin is empty', async () => {
    await assert.rejects(
      withArgv(['--from', 'en', '--to', 'fr', '--config', tmpDir], () => main({ stdin: fakeStdin([' \n']) })),
      (err: unknown) =>
        err instanceof LoquiError && err.code === 'INVALID_USAGE' && /empty input from stdin/.test(err.message),
    );
  });
});

describe('runInit', () => {
  test('refuses to run outside an interactive terminal', async () => {
    await assert.rejects(
      runInit({ input: fakeStdin([]), output: sink(), cwd: tmpDir }),
      (err: unknown) =>
        err instanceof LoquiError && err.code === 'INVALID_USAGE' && /interactive terminal/.test(err.message),
    );
  });

  test('writes a config from the answers given', async () => {
    const initDir = path.join(tmpDir, 'init-answers');
    fs.mkdirSync(initDir, { recursive: true });
    const io = wizardIO(['openai\n', 'gpt-5-mini\n', 'en\n', 'fr, de\n', 'a checkout flow\n']);

    await runInit({ input: io.input, output: io.output, cwd: initDir });

    const written = JSON.parse(fs.readFileSync(path.join(initDir, '.loqui.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(written.engine, 'openai');
    assert.equal(written.model, 'gpt-5-mini');
    assert.equal(written.from, 'en');
    assert.deepEqual(written.to, ['fr', 'de']);
    assert.equal(written.context, 'a checkout flow');
    assert.match(io.text(), /OPENAI_API_KEY/);
  });

  test('falls back to the defaults on empty answers and omits an empty context', async () => {
    const initDir = path.join(tmpDir, 'init-defaults');
    fs.mkdirSync(initDir, { recursive: true });

    const io = wizardIO(['\n', '\n', '\n', '\n', '\n']);
    await runInit({ input: io.input, output: io.output, cwd: initDir });

    const written = JSON.parse(fs.readFileSync(path.join(initDir, '.loqui.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(written.engine, 'gemini');
    assert.equal(written.from, 'en');
    assert.deepEqual(written.to, ['fr', 'de', 'es']);
    assert.ok(!('context' in written), 'an empty context should not be written');
  });

  test('rejects an unknown engine with INVALID_USAGE and releases the terminal first', async () => {
    const initDir = path.join(tmpDir, 'init-bad-engine');
    fs.mkdirSync(initDir, { recursive: true });
    const io = wizardIO(['klingon\n']);

    await assert.rejects(
      runInit({ input: io.input, output: io.output, cwd: initDir }),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_USAGE' && /Unknown engine/.test(err.message),
    );

    assert.ok(io.input.isPaused(), 'readline must be closed, or the process never exits');
  });

  test('leaves an existing config alone when the overwrite prompt is declined', async () => {
    const initDir = path.join(tmpDir, 'init-existing');
    fs.mkdirSync(initDir, { recursive: true });
    const configPath = path.join(initDir, '.loqui.json');
    fs.writeFileSync(configPath, '{"from":"keep-me"}', 'utf-8');
    const io = wizardIO(['n\n']);

    await runInit({ input: io.input, output: io.output, cwd: initDir });

    assert.equal(fs.readFileSync(configPath, 'utf-8'), '{"from":"keep-me"}');
    assert.match(io.text(), /Aborted/);
  });

  test('overwrites an existing config when the prompt is accepted', async () => {
    const initDir = path.join(tmpDir, 'init-overwrite');
    fs.mkdirSync(initDir, { recursive: true });
    const configPath = path.join(initDir, '.loqui.json');
    fs.writeFileSync(configPath, '{"from":"stale"}', 'utf-8');

    const io = wizardIO(['y\n', 'anthropic\n', '\n', 'en\n', 'nl\n', '\n']);
    await runInit({ input: io.input, output: io.output, cwd: initDir });

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    assert.equal(written.engine, 'anthropic');
    assert.deepEqual(written.to, ['nl']);
  });
});

describe('parseArgs — unknown and malformed options', () => {
  const invalidUsage = (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_USAGE';

  test('rejects an unknown option instead of ignoring it', () => {
    assert.throws(() => parseArgs(argv('--nonsense')), invalidUsage);
  });

  test('suggests the flag a typo was reaching for', () => {
    assert.throws(
      () => parseArgs(argv('--incremetal')),
      (err: unknown) => err instanceof LoquiError && err.message.includes('--incremental'),
    );
  });

  test('points at --help when nothing is close', () => {
    assert.throws(
      () => parseArgs(argv('--wildly-wrong')),
      (err: unknown) => err instanceof LoquiError && err.message.includes('--help'),
    );
  });

  test('rejects a value attached to a boolean flag', () => {
    assert.throws(() => parseArgs(argv('--dry-run=yes')), invalidUsage);
  });

  test('a lone dash is rejected rather than read as input', () => {
    assert.throws(() => parseArgs(argv('-')), invalidUsage);
  });
});

describe('parseArgs — a token that would be silently dropped', () => {
  const rejects = (token: string) => (err: unknown) =>
    err instanceof LoquiError && err.code === 'INVALID_USAGE' && err.message.includes(token);

  test('a second positional is rejected, naming it', () => {
    assert.throws(() => parseArgs(argv('en.json', '--to', 'fr', 'de')), rejects('de'));
  });

  test('a value flag followed by a boolean flag is rejected rather than eating it', () => {
    assert.throws(() => parseArgs(argv('--output', '--incremental')), rejects('--output'));
  });

  test('a value flag followed by another value flag is rejected', () => {
    assert.throws(() => parseArgs(argv('--from', '--to', 'fr')), rejects('--from'));
  });

  test('a value that looks like a flag but is not one stays legal', () => {
    assert.equal(parseArgs(argv('--context', '--not-a-flag')).context, '--not-a-flag');
  });

  test('the = form takes a known flag name as a plain value', () => {
    assert.equal(parseArgs(argv('--output=--incremental')).output, '--incremental');
  });
});

describe('parseArgs — the --flag=value form', () => {
  test('reads a value attached with =', () => {
    const args = parseArgs(argv('--from=en', '--to=fr,de'));
    assert.equal(args.from, 'en');
    assert.equal(args.to, 'fr,de');
  });

  test('keeps an = that is part of the value', () => {
    assert.equal(parseArgs(argv('--context=a=b')).context, 'a=b');
  });

  test('accepts an empty value', () => {
    assert.equal(parseArgs(argv('--context=')).context, '');
  });

  test('a value starting with a dash is still consumed in the spaced form', () => {
    assert.equal(parseArgs(argv('--context', '--not-a-flag')).context, '--not-a-flag');
  });
});

describe('main — help text', () => {
  test('the exit-code table matches what the codes now cover', async () => {
    const streams = await captureStreams(async (stdout) => {
      await withArgv(['--help'], () => main({ stdout }));
    });

    assert.match(streams.out, /4 +TIMEOUT +— request timed out\n/);
    assert.match(streams.out, /7 +PARSE_ERROR +— a response, the input, or a file on disk is not valid JSON\n/);
    assert.match(streams.out, /11 +INVALID_USAGE +— invalid command-line usage\n?/);
  });
});

describe('main — usage errors', () => {
  test('--help wins over a mistyped neighbour', async () => {
    const streams = await captureStreams(async (stdout) => {
      await withArgv(['--incremetal', '--help'], () => main({ stdout }));
    });

    assert.match(streams.out, /loqui — i18n translation CLI/);
  });

  test('an unknown option exits 11', async () => {
    const realExit = process.exit;
    let observed: number | undefined;
    process.exit = ((code?: number) => {
      observed = code;
      return undefined as never;
    }) as typeof process.exit;

    let err = '';
    const realErrWrite = process.stderr.write;
    process.stderr.write = ((c: string) => {
      err += String(c);
      return true;
    }) as typeof process.stderr.write;

    try {
      process.argv = argv('--nonsense');
      run();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.exit = realExit;
      process.stderr.write = realErrWrite;
    }

    assert.equal(observed, 11);
    assert.match(err, /unknown option/);
  });
});
