import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseArgs } from './cli-args.js';
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
