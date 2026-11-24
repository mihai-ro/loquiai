export type LogLevel = 'info' | 'warn' | 'debug';

/** Receives every message a run produces. The library writes to no stream itself. */
export type LogFn = (level: LogLevel, message: string) => void;

const BLUE = '\x1b[0;34m';
const ORANGE = '\x1b[0;33m';
const DIM = '\x1b[2m';
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
 * its result JSON to stdout and `loqui … > es.json` must stay valid JSON.
 */
function write(codes: string, msg: string): void {
  process.stderr.write(colorEnabled() ? `${codes}${msg}${NC}\n` : `${msg}\n`);
}

/** A `LogFn` that prints to stderr, in colour on a terminal and plain otherwise. */
export const stderrLogger: LogFn = (level, message) => {
  if (level === 'warn') write(ORANGE, `[❗️] ${message}`);
  else if (level === 'debug') write(DIM, ` ${message}`);
  else write(BLUE, ` ${message}`);
};
