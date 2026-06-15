import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EXIT_CODES, LoquiError, type LoquiErrorCode } from './errors.js';

describe('LoquiError', () => {
  test('is an instance of Error', () => {
    const err = new LoquiError('AUTH', 'api key missing');
    assert(err instanceof Error);
  });

  test('exposes a stable code', () => {
    const err = new LoquiError('RATE_LIMIT', 'too many requests');
    assert.equal(err.code, 'RATE_LIMIT');
  });

  test('name is LoquiError', () => {
    const err = new LoquiError('TIMEOUT', 'timed out');
    assert.equal(err.name, 'LoquiError');
  });

  test('message is accessible', () => {
    const err = new LoquiError('INVALID_RESPONSE', 'bad json');
    assert.equal(err.message, 'bad json');
  });

  test('can carry a cause', () => {
    const cause = new Error('root cause');
    const err = new LoquiError('CHUNK_FAILED', 'chunk 1 failed', { cause });
    assert.equal(err.cause, cause);
  });

  test('passes instanceof check after serialization round-trip', () => {
    const err = new LoquiError('PARSE_ERROR', 'oops');
    const wrapped = new Error('wrapper', { cause: err });
    assert(wrapped.cause instanceof LoquiError);
    assert.equal((wrapped.cause as LoquiError).code, 'PARSE_ERROR');
  });
});

describe('EXIT_CODES', () => {
  const ALL_CODES: LoquiErrorCode[] = [
    'AUTH',
    'RATE_LIMIT',
    'TIMEOUT',
    'NETWORK_ERROR',
    'INVALID_RESPONSE',
    'PARSE_ERROR',
    'CHUNK_FAILED',
    'INVALID_CONFIG',
  ];

  test('every LoquiErrorCode has a unique exit code', () => {
    const values = ALL_CODES.map((c) => EXIT_CODES[c]);
    const unique = new Set(values);
    assert.equal(unique.size, ALL_CODES.length, 'exit codes must be unique');
  });

  test('all exit codes are integers > 1 and < 128', () => {
    for (const code of ALL_CODES) {
      const n = EXIT_CODES[code];
      assert.ok(Number.isInteger(n) && n > 1 && n < 128, `${code}: invalid exit code ${n}`);
    }
  });

  test('AUTH maps to 2', () => {
    assert.equal(EXIT_CODES.AUTH, 2);
  });

  test('RATE_LIMIT maps to 3', () => {
    assert.equal(EXIT_CODES.RATE_LIMIT, 3);
  });

  test('INVALID_CONFIG maps to 9', () => {
    assert.equal(EXIT_CODES.INVALID_CONFIG, 9);
  });
});
