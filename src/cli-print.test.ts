import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, test } from 'node:test';
import { logStats, printError } from './cli-print.js';
import type { RunStats } from './types.js';

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

describe('logStats — the end-of-run summary', () => {
  const stats = (over: Partial<RunStats> = {}): RunStats => ({
    keysTranslated: 0,
    apiRequests: 0,
    elapsedMs: 0,
    warnings: [],
    failedChunks: 0,
    ...over,
  });

  async function plain(fn: () => void): Promise<string> {
    const saved = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      return (await captureStreams(async () => fn())).err;
    } finally {
      if (saved === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved;
    }
  }

  test('prints the failure count, the totals line and every warning again', async () => {
    const err = await plain(() =>
      logStats(stats({ keysTranslated: 3, apiRequests: 2, elapsedMs: 1500, failedChunks: 1, warnings: ['w1', 'w2'] })),
    );

    assert.equal(
      err,
      '[❗️] 1 chunk(s) failed — the keys they carried were not translated.\n keys translated: 3 | requests: 2 | 1.5s\n[❗️] w1\n[❗️] w2\n',
    );
  });

  test('says nothing for a run that translated nothing and warned of nothing', async () => {
    assert.equal(await plain(() => logStats(stats())), '');
  });
});

describe('the CLI printers', () => {
  async function stderrOf(fn: () => void, { tty, noColor }: { tty: boolean; noColor: boolean }): Promise<string> {
    const savedColor = process.env.NO_COLOR;
    const savedTTY = process.stderr.isTTY;
    if (noColor) process.env.NO_COLOR = '1';
    else delete process.env.NO_COLOR;
    process.stderr.isTTY = tty;
    try {
      return (await captureStreams(async () => fn())).err;
    } finally {
      if (savedColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedColor;
      process.stderr.isTTY = savedTTY;
    }
  }

  test('the error line keeps its prefix in both colour modes', async () => {
    assert.equal(await stderrOf(() => printError('boom'), { tty: true, noColor: true }), ' ❌ Error: boom\n');

    const tinted = await stderrOf(() => printError('boom'), { tty: true, noColor: false });
    assert.match(tinted, /❌ Error:/);
    assert.match(tinted, /boom/);
    assert.ok(tinted.includes('\u001b['));
  });
});
