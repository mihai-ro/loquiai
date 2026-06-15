export type LoquiErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'PARSE_ERROR'
  | 'CHUNK_FAILED'
  | 'INVALID_CONFIG';

export class LoquiError extends Error {
  readonly code: LoquiErrorCode;

  constructor(code: LoquiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LoquiError';
    this.code = code;
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
};
