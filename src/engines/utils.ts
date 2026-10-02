import { LoquiError } from '../errors.js';
import { logger } from '../utils/logger.js';

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

/**
 * Values that mean "the response was cut short by a token limit", across the three
 * engines: OpenAI `finish_reason: "length"`, Anthropic `stop_reason: "max_tokens"` or
 * `"model_context_window_exceeded"`, Gemini `finishReason: "MAX_TOKENS"`.
 */
const TRUNCATION_REASONS = new Set(['length', 'max_tokens', 'model_context_window_exceeded']);

/**
 * Fails a response that was cut off by the token limit.
 *
 * A truncated body either fails to parse — surfacing as a misleading PARSE_ERROR — or
 * parses into a short object whose missing keys extractTranslations fills with empty
 * strings. That is a partial translation, silently saved and billed in full, so it has
 * to fail loudly instead.
 */
export function assertComplete(reason: string | undefined, engineName: string): void {
  if (reason && TRUNCATION_REASONS.has(reason.toLowerCase())) {
    throw new LoquiError(
      'TRUNCATED',
      `${engineName} stopped at the output token limit (${reason}) — the response was cut off. Lower splitToken to send smaller chunks, or reduce the number of target locales per run.`,
    );
  }
}

export function exponentialBackoff(attempt: number, baseMs = 5_000, maxMs = 120_000): number {
  const exponential = baseMs * 2 ** attempt;
  const jitter = Math.random() * baseMs;
  return Math.min(exponential + jitter, maxMs);
}

export function defaultRetryAfterHeader(headers: Headers): number | null {
  const header = headers.get('retry-after');
  if (!header) return null;
  const seconds = parseInt(header, 10);
  return Number.isFinite(seconds) ? seconds * 1000 + 500 : null;
}

/** Status codes that warrant a retry with backoff. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 529]);

export interface RetryOptions {
  maxRetries?: number;
  /** the server's own wait before a retry, in ms, from a 429's headers and body. */
  parseRetryDelay?: (headers: Headers, body: string) => number | null;
  engineName?: string;
  timeoutMs?: number;
  /** called immediately when a 429 is received (before the retry sleep). Used by AIMD. */
  onRateLimited?: () => void;
  /** injectable fetch implementation — used in tests to avoid real network calls. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  /** override sleep — use `() => Promise.resolve()` in tests for instant retries. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Sends the request, retrying what is transient, and returns the parsed JSON body.
 * A 2xx body that is not JSON is INVALID_RESPONSE: it is a proxy or gateway page, not
 * an answer, and a retry would fetch the same page.
 */
export async function fetchWithRetry(url: string, init: RequestInit, options: RetryOptions = {}): Promise<unknown> {
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
    let bodyText: string;

    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
      // The body is read here, while the abort is still armed. Clearing the timeout
      // as soon as headers arrive leaves the body read unbounded, so a server that
      // answers and then stalls mid-body hangs the run forever.
      bodyText = await response.text();
    } catch (err) {
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
      logger.dim(
        `[retry] ${engineName} network error — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`,
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
        const code = response.status === 429 ? 'RATE_LIMIT' : 'INVALID_RESPONSE';
        throw new LoquiError(
          code,
          `${engineName} ${response.status} after ${maxRetries} retries. ${sanitizeForDisplay(bodyText)}`,
        );
      }

      const serverDelay = response.status === 429 ? parseRetryDelay(response.headers, bodyText) : null;
      const waitMs = serverDelay ?? exponentialBackoff(attempt);
      logger.dim(
        `[retry] ${engineName} ${response.status} — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`,
      );
      await sleepImpl(waitMs);
      attempt++;
      continue;
    }

    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'AUTH' : 'INVALID_RESPONSE';
      throw new LoquiError(code, `${engineName} API error ${response.status}: ${sanitizeForDisplay(bodyText)}`);
    }

    try {
      return JSON.parse(bodyText);
    } catch {
      throw new LoquiError(
        'INVALID_RESPONSE',
        `${engineName} returned a body that is not JSON: ${sanitizeForDisplay(bodyText) || '(empty)'}`,
      );
    }
  }
}
