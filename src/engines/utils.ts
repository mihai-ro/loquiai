export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function truncate(s: string, max = 300): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function exponentialBackoff(attempt: number, baseMs = 5_000, maxMs = 120_000): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs;
  return Math.min(exponential + jitter, maxMs);
}

export async function defaultRetryAfterHeader(response: Response): Promise<number | null> {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = parseInt(header, 10);
  return Number.isFinite(seconds) ? seconds * 1000 + 500 : null;
}

export interface RetryOptions {
  maxRetries?: number;
  parseRetryDelay?: (response: Response) => Promise<number | null>;
  engineName?: string;
  timeoutMs?: number;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const {
    maxRetries = 5,
    parseRetryDelay = defaultRetryAfterHeader,
    engineName = 'API',
    timeoutMs = 120_000,
  } = options;

  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`[${engineName}] Request timed out after ${timeoutMs / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error(`${engineName} 429 after ${maxRetries} retries. Reduce concurrency or upgrade your API plan.`);
      }
      const serverDelay = await parseRetryDelay(response);
      const waitMs = serverDelay ?? exponentialBackoff(attempt);
      process.stderr.write(
        `\x1b[2m [retry] ${engineName} 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...\x1b[0m\n`
      );
      await sleep(waitMs);
      attempt++;
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${engineName} API error ${response.status}: ${errorText}`);
    }

    return response;
  }
}
