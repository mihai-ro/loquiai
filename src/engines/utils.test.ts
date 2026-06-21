import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LoquiError } from '../errors.js';
import { fetchWithRetry, sanitizeForDisplay, truncate } from './utils.js';

// Minimal mock response helper.
function mockResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('sanitizeForDisplay', () => {
  test('strips OpenAI-style sk- keys', () => {
    const text = 'API error with key sk-1234567890abcdefghij1234567890abcdef';
    const result = sanitizeForDisplay(text);
    assert.ok(result.includes('sk-***REDACTED***'));
    assert.ok(!result.includes('1234567890'));
  });

  test('strips Gemini gsk_ keys', () => {
    const text = 'gsk_1234567890abcdefghijklmnopqrstuvwxyz refused';
    const result = sanitizeForDisplay(text);
    assert.ok(result.includes('gsk_***REDACTED***'));
  });

  test('strips Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def12345678901234';
    const result = sanitizeForDisplay(text);
    assert.ok(result.includes('Bearer ***REDACTED***'));
  });

  test('strips JSON-stringified api_key values', () => {
    const text = '{"x-api-key": "sk-abcdefghijklmnopqrst"}';
    const result = sanitizeForDisplay(text);
    assert.ok(!result.includes('sk-abcdefghijklmnopqrst'));
    assert.ok(result.includes('REDACTED'));
  });

  test('truncates long text', () => {
    const text = 'x'.repeat(500);
    const result = sanitizeForDisplay(text, 100);
    assert.ok(result.length <= 102); // 100 + '…' + possible re-match expansion
    assert.ok(result.includes('…'));
  });

  test('preserves safe text unchanged', () => {
    const text = 'Translation failed: no valid response';
    const result = sanitizeForDisplay(text);
    assert.equal(result, text);
  });
});

describe('truncate', () => {
  test('truncates long strings', () => {
    const result = truncate('hello world', 5);
    assert.equal(result, 'hello…');
  });

  test('returns short strings unchanged', () => {
    const result = truncate('hi', 5);
    assert.equal(result, 'hi');
  });
});

const noSleep = (): Promise<void> => Promise.resolve();

describe('fetchWithRetry — 5xx transient retry', () => {
  test('retries 503 and succeeds on second attempt', async () => {
    let calls = 0;
    const result = await fetchWithRetry(
      'http://test',
      {},
      {
        engineName: 'Test',
        maxRetries: 3,
        sleepFn: noSleep,
        fetchFn: async () => {
          calls++;
          return calls < 2 ? mockResponse(503, 'unavailable') : mockResponse(200, '{}');
        },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  });

  test('retries 500 up to maxRetries then throws LoquiError', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        fetchWithRetry(
          'http://test',
          {},
          {
            engineName: 'MyEngine',
            maxRetries: 2,
            sleepFn: noSleep,
            fetchFn: async () => {
              calls++;
              return mockResponse(500, 'Server Error');
            },
          },
        ),
      (err: unknown) => {
        assert(err instanceof LoquiError);
        assert.equal(err.code, 'INVALID_RESPONSE');
        assert.ok(err.message.includes('MyEngine'));
        return true;
      },
    );
    assert.equal(calls, 3); // initial + 2 retries
  });

  test('retries 408 Request Timeout', async () => {
    let calls = 0;
    const result = await fetchWithRetry(
      'http://test',
      {},
      {
        engineName: 'Test',
        maxRetries: 3,
        sleepFn: noSleep,
        fetchFn: async () => {
          calls++;
          return calls < 2 ? mockResponse(408, 'timeout') : mockResponse(200, '{}');
        },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  });

  test('retries 529 (provider overloaded)', async () => {
    let calls = 0;
    const result = await fetchWithRetry(
      'http://test',
      {},
      {
        engineName: 'Test',
        maxRetries: 3,
        sleepFn: noSleep,
        fetchFn: async () => {
          calls++;
          return calls < 2 ? mockResponse(529, 'overloaded') : mockResponse(200, '{}');
        },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  });

  test('does NOT retry 400 Bad Request', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        fetchWithRetry(
          'http://test',
          {},
          {
            engineName: 'Test',
            maxRetries: 3,
            sleepFn: noSleep,
            fetchFn: async () => {
              calls++;
              return mockResponse(400, 'bad request');
            },
          },
        ),
      (err: unknown) => {
        assert(err instanceof LoquiError);
        assert.ok(err.message.includes('400'));
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  test('does NOT retry 401 — throws with AUTH code', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        fetchWithRetry(
          'http://test',
          {},
          {
            engineName: 'Test',
            maxRetries: 3,
            sleepFn: noSleep,
            fetchFn: async () => {
              calls++;
              return mockResponse(401, 'unauthorized');
            },
          },
        ),
      (err: unknown) => {
        assert(err instanceof LoquiError);
        assert.equal(err.code, 'AUTH');
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  test('retries on network error and succeeds', async () => {
    let calls = 0;
    const result = await fetchWithRetry(
      'http://test',
      {},
      {
        engineName: 'Test',
        maxRetries: 3,
        sleepFn: noSleep,
        fetchFn: async () => {
          calls++;
          if (calls < 2) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
          return mockResponse(200, '{}');
        },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  });

  test('network error exhausting retries throws LoquiError wrapping the original', async () => {
    const cause = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    await assert.rejects(
      () =>
        fetchWithRetry(
          'http://test',
          {},
          {
            engineName: 'MyEngine',
            maxRetries: 1,
            sleepFn: noSleep,
            fetchFn: async () => {
              throw cause;
            },
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof LoquiError);
        assert.equal(err.code, 'NETWORK_ERROR');
        assert.ok(err.message.includes('MyEngine'));
        assert.ok(err.message.includes('fetch failed'));
        assert.equal(err.cause, cause);
        return true;
      },
    );
  });

  test('calls onRateLimited when 429 is encountered', async () => {
    let rateLimitSignals = 0;
    let calls = 0;
    await fetchWithRetry(
      'http://test',
      {},
      {
        engineName: 'Test',
        maxRetries: 3,
        sleepFn: noSleep,
        onRateLimited: () => rateLimitSignals++,
        fetchFn: async () => {
          calls++;
          return calls < 2 ? mockResponse(429, 'rate limited') : mockResponse(200, '{}');
        },
      },
    );
    assert.equal(rateLimitSignals, 1);
  });
});
