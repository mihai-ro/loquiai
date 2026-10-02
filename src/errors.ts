import type { HashStore, TranslationMemory, TranslationRun } from './types.js';

export type LoquiErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'PARSE_ERROR'
  | 'CHUNK_FAILED'
  | 'INVALID_CONFIG'
  | 'TRUNCATED'
  | 'INVALID_USAGE';

/** What a run that failed in some of its chunks did get done. */
export type FailedRunResult = TranslationRun & {
  /** set by `translateObject()`, for a caller that persists partial progress. */
  hashes?: HashStore;
  memory?: TranslationMemory;
  /** set by `translate()`: the files written before it gave up. */
  written?: Record<string, string>;
};

export interface LoquiErrorOptions extends ErrorOptions {
  result?: FailedRunResult;
}

export class LoquiError extends Error {
  readonly code: LoquiErrorCode;
  /** Present when chunks failed: everything that did land, and the run's stats. Absent when the run stopped before sending anything. */
  readonly result?: FailedRunResult;

  constructor(code: LoquiErrorCode, message: string, options?: LoquiErrorOptions) {
    super(message, options);
    this.name = 'LoquiError';
    this.code = code;
    this.result = options?.result;
    // Restore prototype chain for instanceof checks across compilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** CLI exit codes for each LoquiErrorCode. Exit 1 is reserved for unknown errors. */
export const EXIT_CODES: Record<LoquiErrorCode, number> = {
  AUTH: 2,
  RATE_LIMIT: 3,
  TIMEOUT: 4,
  NETWORK_ERROR: 5,
  INVALID_RESPONSE: 6,
  PARSE_ERROR: 7,
  CHUNK_FAILED: 8,
  INVALID_CONFIG: 9,
  TRUNCATED: 10,
  INVALID_USAGE: 11,
};
