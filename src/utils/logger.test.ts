import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { logger } from './logger.js';

const ANSI_PREFIX = '\u001b[';

const METHODS = ['info', 'warn', 'error', 'success', 'header', 'dim'] as const;

interface Capture {
  out: string[];
  err: string[];
}

/** Swaps both streams' write + isTTY, returns what each received. */
function capture(fn: () => void, { isTTY = false }: { isTTY?: boolean } = {}): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const realTTY = process.stderr.isTTY;

  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stderr.isTTY = isTTY;

  try {
    fn();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.stderr.isTTY = realTTY;
  }
  return { out, err };
}

const savedNoColor = process.env.NO_COLOR;

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
});

describe('logger stream routing', () => {
  for (const method of METHODS) {
    test(`${method} writes to stderr and never to stdout`, () => {
      delete process.env.NO_COLOR;
      const { out, err } = capture(() => {
        logger[method]('hello');
      });

      assert.deepEqual(out, [], `logger.${method} polluted stdout`);
      assert.equal(err.length, 1);
      assert.match(err[0], /hello/);
      assert.match(err[0], /\n$/);
    });
  }

  test('stdout stays clean across a full run of diagnostics', () => {
    const { out } = capture(() => {
      for (const method of METHODS) logger[method]('noise');
    });
    assert.equal(out.join(''), '');
  });
});

describe('logger colour gating', () => {
  test('emits ANSI escapes when stderr is a TTY and NO_COLOR is unset', () => {
    delete process.env.NO_COLOR;
    const { err } = capture(
      () => {
        logger.info('tinted');
      },
      { isTTY: true },
    );
    assert.ok(err[0].includes(ANSI_PREFIX), `expected ANSI escapes, got ${JSON.stringify(err[0])}`);
  });

  test('omits ANSI escapes when stderr is not a TTY', () => {
    delete process.env.NO_COLOR;
    const { err } = capture(
      () => {
        logger.info('plain');
      },
      { isTTY: false },
    );
    assert.ok(!err[0].includes(ANSI_PREFIX));
    assert.equal(err[0], ' plain\n');
  });

  test('omits ANSI escapes when NO_COLOR is set, even on a TTY', () => {
    process.env.NO_COLOR = '1';
    const { err } = capture(
      () => {
        for (const method of METHODS) logger[method]('plain');
      },
      { isTTY: true },
    );
    for (const line of err) assert.ok(!line.includes(ANSI_PREFIX), `unexpected ANSI escapes: ${JSON.stringify(line)}`);
  });

  test('error keeps its prefix in both colour modes', () => {
    process.env.NO_COLOR = '1';
    const plain = capture(
      () => {
        logger.error('boom');
      },
      { isTTY: true },
    );
    assert.equal(plain.err[0], ' ❌ Error: boom\n');

    delete process.env.NO_COLOR;
    const tinted = capture(
      () => {
        logger.error('boom');
      },
      { isTTY: true },
    );
    assert.match(tinted.err[0], /❌ Error:/);
    assert.match(tinted.err[0], /boom/);
  });
});
