import { LoquiError } from '../errors.js';

/**
 * Maximum locales × keys product before engines fall back from structured-output
 * schemas (OpenAI json_schema / Anthropic tool_use). Shared constant — change here
 * propagates to all engines and the chunk-size guard in translator.ts.
 * OpenAI strict mode caps total object properties at 100; L×K ≤ 90 keeps
 * L×(1+K) ≤ 90+L comfortably under that. Anthropic has no hard limit; 90 mirrors
 * OpenAI for consistency.
 */
export const STRUCTURED_OUTPUT_MAX_PROPS = 90;

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Strips API keys and secrets from text before displaying in error messages.
 * Catches common patterns: sk- (OpenAI), gsk_ (Gemini), Bearer tokens, JSON-stringified secrets.
 */
export function sanitizeForDisplay(text: string, max = 300): string {
  const truncated = text.length > max ? `${text.slice(0, max)}…` : text;
  return truncated
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-***REDACTED***')
    .replace(/gsk_[A-Za-z0-9]{20,}/g, 'gsk_***REDACTED***')
    .replace(/(Bearer\s+)[A-Za-z0-9\-_.]{20,}/gi, '$1***REDACTED***')
    .replace(/"(?:api[_-]?key|x-api-key|key|token|secret)":\s*"([^"]{16,})"/gi, '"$1":"***REDACTED***"');
}

export function exponentialBackoff(attempt: number, baseMs = 5_000, maxMs = 120_000): number {
  const exponential = baseMs * 2 ** attempt;
  const jitter = Math.random() * baseMs;
  return Math.min(exponential + jitter, maxMs);
}

export async function defaultRetryAfterHeader(response: Response): Promise<number | null> {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = parseInt(header, 10);
  return Number.isFinite(seconds) ? seconds * 1000 + 500 : null;
}

/** Status codes that warrant a retry with backoff. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 529]);

export interface RetryOptions {
  maxRetries?: number;
  parseRetryDelay?: (response: Response) => Promise<number | null>;
  engineName?: string;
  timeoutMs?: number;
  /** called immediately when a 429 is received (before the retry sleep). Used by AIMD. */
  onRateLimited?: () => void;
  /** injectable fetch implementation — used in tests to avoid real network calls. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  /** override sleep — use `() => Promise.resolve()` in tests for instant retries. */
  sleepFn?: (ms: number) => Promise<void>;
}

export async function fetchWithRetry(url: string, init: RequestInit, options: RetryOptions = {}): Promise<Response> {
  const {
    maxRetries = 5,
    parseRetryDelay = defaultRetryAfterHeader,
    engineName = 'API',
    timeoutMs = 120_000,
    onRateLimited,
    fetchFn,
    sleepFn,
  } = options;

  const fetchImpl = fetchFn ?? fetch;
  const sleepImpl = sleepFn ?? sleep;
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;

    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === 'AbortError') {
        throw new LoquiError('TIMEOUT', `[${engineName}] Request timed out after ${timeoutMs / 1000}s`);
      }
      // transient network error (ECONNRESET, ETIMEDOUT, DNS failure, etc.) — retry.
      if (attempt >= maxRetries)
        throw new LoquiError(
          'NETWORK_ERROR',
          `${engineName} network error after ${maxRetries} retries: ${(err as Error).message}`,
          { cause: err },
        );
      const waitMs = exponentialBackoff(attempt);
      process.stderr.write(
        `\x1b[2m [retry] ${engineName} network error — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...\x1b[0m\n`,
      );
      await sleepImpl(waitMs);
      attempt++;
      continue;
    } finally {
      clearTimeout(timeoutId);
    }

    if (RETRYABLE_STATUS.has(response.status)) {
      if (response.status === 429) onRateLimited?.();

      if (attempt >= maxRetries) {
        const errorText = await response.text();
        const code = response.status === 429 ? 'RATE_LIMIT' : 'INVALID_RESPONSE';
        throw new LoquiError(
          code,
          `${engineName} ${response.status} after ${maxRetries} retries. ${sanitizeForDisplay(errorText)}`,
        );
      }

      const serverDelay = response.status === 429 ? await parseRetryDelay(response) : null;
      const waitMs = serverDelay ?? exponentialBackoff(attempt);
      process.stderr.write(
        `\x1b[2m [retry] ${engineName} ${response.status} — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...\x1b[0m\n`,
      );
      await sleepImpl(waitMs);
      attempt++;
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const code = response.status === 401 || response.status === 403 ? 'AUTH' : 'INVALID_RESPONSE';
      throw new LoquiError(code, `${engineName} API error ${response.status}: ${sanitizeForDisplay(errorText)}`);
    }

    return response;
  }
}
