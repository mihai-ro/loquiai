import type { DiffResult } from './diff.js';
import type { RunStats } from './types.js';
import { stderrLogger } from './utils/logger.js';
import type { ValidationResult } from './validate.js';

const BLUE = '\x1b[0;34m';
const GREEN = '\x1b[0;32m';
const RED = '\x1b[0;31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

/** Decided per call so a caller that swaps the stream or NO_COLOR between writes is honoured. */
function colorEnabled(): boolean {
  return Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
}

/** The run's own diagnostics reach stderr through `stderrLogger`; these three lines are the CLI's. */
export function printHeader(msg: string): void {
  process.stderr.write(colorEnabled() ? `${BLUE}${BOLD}${msg}${NC}\n` : `${msg}\n`);
}

export function printSuccess(msg: string): void {
  process.stderr.write(colorEnabled() ? `${GREEN} ✅ ${msg}${NC}\n` : ` ✅ ${msg}\n`);
}

export function printError(msg: string): void {
  process.stderr.write(colorEnabled() ? `${RED} ❌ Error:${NC} ${YELLOW}${msg}${NC}\n` : ` ❌ Error: ${msg}\n`);
}

/** The end-of-run summary: totals, then every warning of the run once more, last where it is seen. */
export function logStats(stats: RunStats): void {
  if (stats.failedChunks > 0) {
    stderrLogger('warn', `${stats.failedChunks} chunk(s) failed — the keys they carried were not translated.`);
  }
  if (stats.keysTranslated > 0 || stats.warnings.length > 0) {
    stderrLogger(
      'debug',
      `keys translated: ${stats.keysTranslated} | requests: ${stats.apiRequests} | ${(stats.elapsedMs / 1000).toFixed(1)}s`,
    );
  }
  for (const w of stats.warnings) {
    stderrLogger('warn', w);
  }
}

/**
 * The reports are results, so they go to stdout, as plain lines: no colour, since
 * stdout is what gets piped. The wording is what they have always printed.
 */
const reportLine = (message: string): string => ` ${message}\n`;

export function formatDiffReport(results: DiffResult[]): string {
  let text = '';
  for (const r of results) {
    text += reportLine(`[${r.locale}]`);
    for (const key of r.added) text += reportLine(`  + ${key}`);
    for (const key of r.removed) text += reportLine(`  - ${key}`);
    for (const key of r.changed) text += reportLine(`  ~ ${key}`);
    text += reportLine(
      `Summary: ${r.added.length} added, ${r.removed.length} removed, ${r.changed.length} changed, ${r.unchanged.length} unchanged`,
    );
  }
  return text;
}

export function formatValidateReport(results: ValidationResult[]): string {
  let text = '';
  let totalMissing = 0;
  let totalExtra = 0;
  let totalOk = 0;
  for (const r of results) {
    text += reportLine(`[${r.locale}]`);
    if (r.fileMissing) text += reportLine(`  ✗ no target file: all ${r.missing.length} key(s) missing`);
    else for (const key of r.missing) text += reportLine(`  ✗ missing: ${key}`);
    for (const key of r.extra) text += reportLine(`  ✗ extra: ${key}`);
    totalMissing += r.missing.length;
    totalExtra += r.extra.length;
    totalOk += r.ok.length;
  }
  return `${text}${reportLine(`Summary: ${totalMissing} missing, ${totalExtra} extra, ${totalOk} ok`)}`;
}
