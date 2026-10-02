import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LoquiError } from '../errors.js';
import { assertComplete, fetchWithRetry, type RetryOptions, sanitizeForDisplay, truncate } from './utils.js';

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

/** fetchWithRetry with the required log defaulted to a no-op, for tests that are not about logging. */
function withRetry(url: string, init: RequestInit, options: Omit<RetryOptions, 'log'> = {}): Promise<unknown> {
  return fetchWithRetry(url, init, { log: () => {}, ...options });
}

describe('fetchWithRetry — logging', () => {
  test('reports each retry through the given log at debug, and writes to no stream itself', async () => {
    const messages: Array<[string, string]> = [];
    let calls = 0;

    await fetchWithRetry(
      'http://test',
      {},
      {
        engineName: 'Test',
        maxRetries: 3,
        sleepFn: noSleep,
        log: (level, message) => {
          messages.push([level, message]);
        },
        fetchFn: async () => {
          calls++;
          return calls < 3 ? mockResponse(503, 'unavailable') : mockResponse(200, '{}');
        },
      },
    );

    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map(([level]) => level),
      ['debug', 'debug'],
    );
    assert.match(messages[0][1], /^\[retry\] Test 503 — waiting .* \(attempt 1\/3\)/);
  });
});

describe('fetchWithRetry — 5xx transient retry', () => {
  test('retries 503 and succeeds on second attempt', async () => {
    let calls = 0;
    const result = await withRetry(
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
    assert.deepEqual(result, {});
    assert.equal(calls, 2);
  });

  test('retries 500 up to maxRetries then throws LoquiError', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
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
    const result = await withRetry(
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
    assert.deepEqual(result, {});
    assert.equal(calls, 2);
  });

  test('retries 529 (provider overloaded)', async () => {
    let calls = 0;
    const result = await withRetry(
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
    assert.deepEqual(result, {});
    assert.equal(calls, 2);
  });

  test('does NOT retry 400 Bad Request', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
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
        withRetry(
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
    const result = await withRetry(
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
    assert.deepEqual(result, {});
    assert.equal(calls, 2);
  });

  test('network error exhausting retries throws LoquiError wrapping the original', async () => {
    const cause = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    await assert.rejects(
      () =>
        withRetry(
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
    await withRetry(
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

describe('assertComplete', () => {
  const truncated = (err: unknown) => err instanceof LoquiError && err.code === 'TRUNCATED';

  test('throws TRUNCATED on the OpenAI reason', () => {
    assert.throws(() => assertComplete('length', 'OpenAI'), truncated);
  });

  test('throws TRUNCATED on the Anthropic reason', () => {
    assert.throws(() => assertComplete('max_tokens', 'Anthropic'), truncated);
  });

  test('throws TRUNCATED on the Gemini reason regardless of case', () => {
    assert.throws(() => assertComplete('MAX_TOKENS', 'Gemini'), truncated);
  });

  test('names the engine and suggests a smaller chunk', () => {
    assert.throws(
      () => assertComplete('length', 'OpenAI'),
      (err: unknown) => err instanceof LoquiError && /OpenAI/.test(err.message) && /splitToken/.test(err.message),
    );
  });

  test('throws TRUNCATED when Anthropic ran out of context window', () => {
    assert.throws(() => assertComplete('model_context_window_exceeded', 'Anthropic'), truncated);
  });

  test('passes normal stop reasons through', () => {
    assert.doesNotThrow(() => assertComplete('stop', 'OpenAI'));
    assert.doesNotThrow(() => assertComplete('end_turn', 'Anthropic'));
    assert.doesNotThrow(() => assertComplete('tool_use', 'Anthropic'));
    assert.doesNotThrow(() => assertComplete('STOP', 'Gemini'));
  });

  test('passes an absent reason through', () => {
    assert.doesNotThrow(() => assertComplete(undefined, 'OpenAI'));
  });
});

describe('fetchWithRetry — response body timeout', () => {
  /** Headers arrive, then the body never does — and honours the abort signal, like fetch. */
  function stallingBody(): RetryOptions['fetchFn'] {
    return async (_url, init) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted.', 'AbortError')),
          );
        },
      });
      return new Response(body, { status: 200 });
    };
  }

  test('times out when the body stalls after the headers arrive', async () => {
    await assert.rejects(
      withRetry('https://example.invalid/v1', {}, { fetchFn: stallingBody(), timeoutMs: 50, maxRetries: 0 }),
      (err: unknown) => err instanceof LoquiError && err.code === 'TIMEOUT',
    );
  });

  test('a normal body comes back parsed', async () => {
    const body = await withRetry(
      'https://example.invalid/v1',
      {},
      { fetchFn: async () => new Response('{"ok":true}', { status: 200 }) },
    );

    assert.deepEqual(body, { ok: true });
  });

  test('an empty 2xx body is an invalid response, not a result', async () => {
    await assert.rejects(
      withRetry('https://example.invalid/v1', {}, { fetchFn: async () => new Response(null, { status: 204 }) }),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_RESPONSE',
    );
  });
});

describe('fetchWithRetry — a 2xx body that is not JSON', () => {
  const html = '<html><body>Bad gateway from a proxy</body></html>';

  test('throws INVALID_RESPONSE with the body, without retrying', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        'http://test',
        {},
        {
          engineName: 'MyEngine',
          sleepFn: noSleep,
          fetchFn: async () => {
            calls++;
            return mockResponse(200, html);
          },
        },
      ),
      (err: unknown) =>
        err instanceof LoquiError &&
        err.code === 'INVALID_RESPONSE' &&
        err.message.includes('MyEngine') &&
        err.message.includes('Bad gateway'),
    );
    assert.equal(calls, 1);
  });

  test('redacts secrets from the body it quotes', async () => {
    await assert.rejects(
      withRetry(
        'http://test',
        {},
        { fetchFn: async () => mockResponse(200, 'echo sk-1234567890abcdefghij1234567890abcdef') },
      ),
      (err: unknown) => err instanceof LoquiError && !err.message.includes('1234567890abcdef'),
    );
  });
});

describe('fetchWithRetry — how long a 429 waits', () => {
  /** Answers 429 once with `headers`/`body`, then succeeds; returns every sleep it was asked for. */
  async function sleepsAfter429(
    headers: HeadersInit,
    body: string,
    options: Omit<RetryOptions, 'log'> = {},
  ): Promise<number[]> {
    const sleeps: number[] = [];
    let calls = 0;
    await withRetry(
      'http://test',
      {},
      {
        engineName: 'Test',
        maxRetries: 3,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
        fetchFn: async () => {
          calls++;
          return calls < 2 ? new Response(body, { status: 429, headers }) : mockResponse(200, '{}');
        },
        ...options,
      },
    );
    return sleeps;
  }

  test('waits what the Retry-After header says', async () => {
    assert.deepEqual(await sleepsAfter429({ 'retry-after': '7' }, 'slow down'), [7_500]);
  });

  test('hands a custom parseRetryDelay the headers and the body text', async () => {
    let seen: { retryAfter: string | null; body: string } | undefined;

    const sleeps = await sleepsAfter429({ 'retry-after': '1' }, 'quota exhausted', {
      parseRetryDelay: (headers, body) => {
        seen = { retryAfter: headers.get('retry-after'), body };
        return 250;
      },
    });

    assert.deepEqual(seen, { retryAfter: '1', body: 'quota exhausted' });
    assert.deepEqual(sleeps, [250]);
  });

  test('backs off on its own when there is no server delay', async () => {
    const [waited] = await sleepsAfter429({}, 'slow down');

    assert.ok(waited >= 5_000, `expected the exponential floor, got ${waited}`);
  });
});
