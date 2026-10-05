import { HELP_TEXT, parseArgs } from './cli-args.js';
import { type InputStream, runInit } from './cli-init.js';
import {
  formatDiffReport,
  formatValidateReport,
  logStats,
  printError,
  printHeader,
  printSuccess,
} from './cli-print.js';
import { EXIT_CODES, LoquiError } from './errors.js';
import { diff, validate } from './inspect.js';
import { translate } from './lib.js';
import type { LoquiConfig, TranslateResult } from './types.js';
import { stderrLogger } from './utils/logger.js';

/** Reads the whole stream. The stream is injectable so tests never touch the real stdin. */
export function readStdin(stream: InputStream = process.stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf-8');
    stream.on('data', (chunk) => (data += chunk));
    stream.on('end', () => resolve(data.trim()));
    stream.on('error', reject);
  });
}

export interface CliIO {
  /** injectable stdin — tests drive the CLI with a stream instead of a terminal. */
  stdin?: InputStream;
  /** where results go. Diagnostics never come here; they go to stderr. */
  stdout?: NodeJS.WritableStream;
}

export async function main({ stdin = process.stdin, stdout = process.stdout }: CliIO = {}): Promise<void> {
  if (process.argv[2] === 'init') {
    await runInit({ input: stdin, output: stdout });
    return;
  }

  // --help is answered before anything can reject a neighbouring token: someone
  // reaching for help should get it, not a lecture about the flag they mistyped.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  const args = parseArgs(process.argv);

  printHeader('[loqui] i18n translator');

  let input = args.input;
  if (!input) {
    if (stdin.isTTY) {
      throw new LoquiError(
        'INVALID_USAGE',
        'No input provided. Use --input <file|json>, a positional arg, or pipe via stdin.',
      );
    }
    input = await readStdin(stdin);
    if (!input) {
      throw new LoquiError('INVALID_USAGE', 'Received empty input from stdin.');
    }
  }

  if (args.dryRun) stderrLogger('warn', 'Dry-run mode — no API calls or file writes.');
  if (args.force) stderrLogger('warn', 'Force mode — all keys will be re-translated.');

  // collect inline overrides — these take priority over the config file
  const configOverrides: Partial<LoquiConfig> = {};
  if (args.engine) configOverrides.engine = args.engine as LoquiConfig['engine'];
  if (args.model) configOverrides.model = args.model;
  if (args.context) configOverrides.context = args.context;

  if (args.diff || args.validate) {
    // the files to inspect are the targets; without --output there are none to find
    const inspect = {
      input,
      configPath: args.config ?? undefined,
      to: args.to ?? undefined,
      output: args.output ?? {},
      hashFile: args.hashFile ?? undefined,
      config: Object.keys(configOverrides).length > 0 ? configOverrides : undefined,
    };
    if (args.diff) {
      const { results, hasBaseline } = diff(inspect);
      if (!hasBaseline) {
        stderrLogger(
          'warn',
          'No hash sidecar found — "changed" cannot be reported. Run once with --incremental to start recording source hashes.',
        );
      }
      stdout.write(formatDiffReport(results));
    } else {
      // Without target files there is nothing to check, and a gate that passes anyway is no gate.
      if (!args.output) throw new LoquiError('INVALID_USAGE', '--validate needs --output: the target files to check.');
      const results = validate(inspect);
      stdout.write(formatValidateReport(results));
      if (results.some((r) => r.missing.length > 0 || r.extra.length > 0)) process.exitCode = 1;
    }
    return;
  }

  let result: TranslateResult;
  try {
    result = await translate({
      input,
      configPath: args.config ?? undefined,
      from: args.from ?? undefined,
      to: args.to ?? undefined,
      output: args.output ?? undefined,
      namespace: args.namespace ?? undefined,
      hashFile: args.hashFile ?? undefined,
      translationMemoryFile: args.translationMemoryFile ?? undefined,
      incremental: args.incremental,
      translationMemory: args.translationMemory,
      dryRun: args.dryRun,
      force: args.force,
      config: Object.keys(configOverrides).length > 0 ? configOverrides : undefined,
      logger: stderrLogger,
    });
  } catch (err) {
    // A run that failed in some chunks still has a summary to give: its warnings.
    if (err instanceof LoquiError && err.result) logStats(err.result.stats);
    throw err;
  }

  const { locales, stats, written } = result;
  logStats(stats);
  const names = Object.keys(locales);
  if (!args.output) {
    stdout.write(`${JSON.stringify(names.length === 1 ? locales[names[0]] : locales, null, 2)}\n`);
  } else if (args.dryRun) {
    printSuccess('Dry run — nothing was written.');
  } else {
    printSuccess(`Done. Wrote ${Object.keys(written).length} locale file(s).`);
  }
}

/**
 * Runs the CLI and maps a LoquiError to its documented exit code.
 * Separated from `main` so tests can drive `main` without the process-exiting wrapper.
 */
export function run(): void {
  main().catch((err) => {
    printError(err.message ?? String(err));
    const code = err instanceof LoquiError ? EXIT_CODES[err.code] : 1;
    process.exit(code);
  });
}
