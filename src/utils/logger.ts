const BLUE = '\x1b[0;34m';
const ORANGE = '\x1b[0;33m';
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

/**
 * Colour is decided per call, not at module load: tests and callers may swap the
 * stream or NO_COLOR between writes, and a cached value would ignore that.
 */
function colorEnabled(): boolean {
  return Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
}

/**
 * Every diagnostic goes to stderr so stdout carries results only — the CLI writes
 * its result JSON to stdout and `loqui … > fr.json` must stay valid JSON.
 */
function write(codes: string, msg: string): void {
  process.stderr.write(colorEnabled() ? `${codes}${msg}${NC}\n` : `${msg}\n`);
}

export const logger = {
  info: (msg: string) => write(BLUE, ` ${msg}`),
  warn: (msg: string) => write(ORANGE, `[❗️] ${msg}`),
  error: (msg: string) => {
    process.stderr.write(colorEnabled() ? `${RED} ❌ Error:${NC} ${YELLOW}${msg}${NC}\n` : ` ❌ Error: ${msg}\n`);
  },
  success: (msg: string) => write(GREEN, ` ✅ ${msg}`),
  header: (msg: string) => write(`${BLUE}${BOLD}`, msg),
  dim: (msg: string) => write(DIM, ` ${msg}`),
};
