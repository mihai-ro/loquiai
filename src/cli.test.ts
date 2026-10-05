import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { main, readStdin, run } from './cli.js';
import type { InputStream } from './cli-init.js';
import { LoquiError } from './errors.js';

/** parseArgs slices argv like the real process does, so fixtures carry the two leading slots. */
function argv(...args: string[]): string[] {
  return ['node', 'loqui', ...args];
}

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

    const parsed = JSON.parse(streams.out) as Record<string, Record<string, string>>;
    assert.deepEqual(Object.keys(parsed).sort(), ['de', 'fr']);
    assert.equal(typeof parsed.fr, 'object', 'each locale is a document, not a JSON string');
  });

  test('--diff writes its report to stdout and nothing but diagnostics to stderr', async () => {
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

    assert.match(streams.out, /\[fr\]/);
    assert.match(streams.out, /Summary:/);
    assert.doesNotMatch(streams.err, /\[fr\]|Summary:/);
  });

  test('--validate without --output rejects with INVALID_USAGE', async () => {
    await assert.rejects(
      withArgv(['{"a":"x"}', '--from', 'en', '--to', 'fr', '--validate', '--config', tmpDir], () => main()),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_USAGE' && /--output/.test(err.message),
    );
  });

  test('--validate fails a locale whose target file does not exist', async () => {
    const dir = path.join(tmpDir, 'validate-no-file');
    fs.mkdirSync(dir, { recursive: true });
    const realExitCode = process.exitCode;

    try {
      const streams = await captureStreams(async (stdout) => {
        await withArgv(
          [
            '{"a":"x","b":"z"}',
            '--from',
            'en',
            '--to',
            'fr',
            '--validate',
            '--output',
            path.join(dir, '{locale}.json'),
            '--config',
            tmpDir,
          ],
          () => main({ stdout }),
        );
      });

      assert.equal(process.exitCode, 1);
      assert.equal(
        streams.out,
        ' [fr]\n   ✗ no target file: all 2 key(s) missing\n Summary: 2 missing, 0 extra, 0 ok\n',
      );
    } finally {
      process.exitCode = realExitCode;
    }
  });

  test('--output reports the files it wrote on stderr instead of dumping JSON', async () => {
    // already translated, so nothing is sent and no engine is needed; the file is still written
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'fr.json'), JSON.stringify({ a: 'x' }), 'utf-8');
    const streams = await captureStreams(async (stdout) => {
      await withArgv(
        ['{"a":"x"}', '--from', 'en', '--to', 'fr', '--output', path.join(outDir, '{locale}.json'), '--config', tmpDir],
        () => main({ stdout }),
      );
    });

    assert.equal(streams.out, '');
    assert.match(streams.err, /Done\. Wrote 1 locale file\(s\)/);
  });

  test('a dry run with --output says nothing was written', async () => {
    const outDir = path.join(tmpDir, 'out-dry');
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
    assert.match(streams.err, /Dry run — nothing was written/);
    assert.doesNotMatch(streams.err, /Wrote/);
    assert.equal(fs.existsSync(outDir), false);
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

describe('main — what the CLI still says on stderr', () => {
  test('a dry run shows the run progress the library now hands to the logger', async () => {
    const streams = await captureStreams(async (stdout) => {
      await withArgv(['{"a":"x"}', '--from', 'en', '--to', 'fr', '--dry-run', '--config', tmpDir], () =>
        main({ stdout }),
      );
    });

    assert.match(streams.err, /\[translation\] \[dry-run\] Translating 1 key\(s\) → fr/);
    assert.match(streams.err, /1 chunk\(s\) over 1 locale group\(s\) = 0 \(dry-run\) request\(s\)/);
  });

  test('--validate prints each mismatch on stdout and exits 1', async () => {
    const dir = path.join(tmpDir, 'validate-mismatch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fr.json'), JSON.stringify({ a: 'x', stale: 'y' }), 'utf-8');
    const realExitCode = process.exitCode;

    try {
      const streams = await captureStreams(async (stdout) => {
        await withArgv(
          [
            '{"a":"x","b":"z"}',
            '--from',
            'en',
            '--to',
            'fr',
            '--validate',
            '--output',
            path.join(dir, '{locale}.json'),
            '--config',
            tmpDir,
          ],
          () => main({ stdout }),
        );
      });

      assert.equal(process.exitCode, 1);
      assert.equal(streams.out, ' [fr]\n   ✗ missing: b\n   ✗ extra: stale\n Summary: 1 missing, 1 extra, 1 ok\n');
      assert.doesNotMatch(streams.err, /missing|Summary/);
    } finally {
      process.exitCode = realExitCode;
    }
  });

  test('--diff without a hash sidecar warns that "changed" cannot be reported', async () => {
    const dir = path.join(tmpDir, 'diff-no-baseline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fr.json'), JSON.stringify({ a: 'x' }), 'utf-8');

    const streams = await captureStreams(async (stdout) => {
      await withArgv(
        [
          '{"a":"x","b":"z"}',
          '--from',
          'en',
          '--to',
          'fr',
          '--diff',
          '--output',
          path.join(dir, '{locale}.json'),
          '--config',
          tmpDir,
        ],
        () => main({ stdout }),
      );
    });

    assert.match(streams.err, /No hash sidecar found/);
    assert.doesNotMatch(streams.err, /Summary/);
    assert.match(streams.out, / {2}\+ b/);
    assert.match(streams.out, /Summary: 1 added, 0 removed, 0 changed, 1 unchanged/);
  });
});

describe('the CLI printers', () => {
  test('the header is tinted on a TTY and plain with NO_COLOR', async () => {
    const run = async (opts: { tty: boolean; noColor: boolean }): Promise<string> => {
      const streams = await captureStreams(async (stdout) => {
        const saved = { color: process.env.NO_COLOR, tty: process.stderr.isTTY };
        if (opts.noColor) process.env.NO_COLOR = '1';
        else delete process.env.NO_COLOR;
        process.stderr.isTTY = opts.tty;
        try {
          await withArgv(['{"a":"x"}', '--from', 'en', '--to', 'fr', '--dry-run', '--config', tmpDir], () =>
            main({ stdout }),
          );
        } finally {
          if (saved.color === undefined) delete process.env.NO_COLOR;
          else process.env.NO_COLOR = saved.color;
          process.stderr.isTTY = saved.tty;
        }
      });
      return streams.err;
    };

    assert.ok((await run({ tty: true, noColor: false })).includes('\u001b['));
    assert.ok(!(await run({ tty: true, noColor: true })).includes('\u001b['));
  });
});

describe('main — a run that fails after some work', () => {
  test("still prints the end-of-run summary from the error's result", async () => {
    const realFetch = globalThis.fetch;
    const realKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    globalThis.fetch = (async () => new Response('denied', { status: 401 })) as typeof fetch;
    let failure: unknown;
    let streams: Streams | undefined;
    try {
      streams = await captureStreams(async (stdout) => {
        await withArgv(['{"a":"x"}', '--from', 'en', '--to', 'fr', '--config', tmpDir], () => main({ stdout })).catch(
          (err) => {
            failure = err;
          },
        );
      });
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = realKey;
    }

    assert.ok(failure instanceof LoquiError && failure.code === 'AUTH', String(failure));
    const warning = failure.result?.stats.warnings[0];
    assert.ok(warning, 'the failed run should carry the warning its chunk raised');
    const printed = streams?.err.split(warning).length ?? 0;
    assert.equal(printed - 1, 2, 'the warning prints live and again in the summary');
  });
});
