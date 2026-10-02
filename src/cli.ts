const HELP_TEXT = `
loqui — i18n translation CLI

Usage:
  loqui [input] [options]
  loqui init                    Interactive setup wizard — creates .loqui.json

  [input] — one of:
    --input <file>         read from a JSON file
    --input '<json>'       pass a JSON string inline
    first positional arg   loqui '{"key":"val"}' --from en --to fr
    stdin                  cat en.json | loqui --from en --to fr

Options:
  --config <path>        Config file or directory (default: .loqui.json in cwd)
  --from <locale>        Source locale — overrides config.from
  --to <locale,...>      Target locale(s), comma-separated — overrides config.to
  --engine <name>        Engine: gemini | openai | anthropic — overrides config.engine
  --model <name>         Model name — overrides config.model
  --context <text>       Domain context injected into prompts — overrides config.context
  --output <path>        Output path. Use {locale} token: ./i18n/{locale}.json
                         Or a plain directory: writes {dir}/{locale}.json
  --namespace <name>     Namespace label injected into translation prompts
  --incremental          Only translate new/changed keys (uses a hash sidecar)
  --hash-file <path>     Hash sidecar path (implies --incremental)
  --translation-memory             Enable translation memory (uses a TM sidecar)
  --translation-memory-file <path> TM sidecar path (implies --translation-memory)
  --dry-run              Preview without calling the API or writing files
  --diff                 Compare source against existing locales, report changes
  --validate             Validate that target locales have the same keys as source
  --force                Re-translate all keys regardless of existing translations
  --help, -h             Show this help

Options take either form: --to fr,de or --to=fr,de.
Inline options always override values from the config file.

Environment variables:
  GEMINI_API_KEY      — required when engine = "gemini"
  OPENAI_API_KEY      — required when engine = "openai"
  ANTHROPIC_API_KEY   — required when engine = "anthropic"

Exit codes:
  0  success
  1  unexpected error
  2  AUTH            — invalid or missing API key
  3  RATE_LIMIT      — rate limit exhausted after retries
  4  TIMEOUT         — request timed out
  5  NETWORK_ERROR   — network failure after retries
  6  INVALID_RESPONSE — API returned an unexpected response
  7  PARSE_ERROR     — a response, the input, or a file on disk is not valid JSON
  8  CHUNK_FAILED    — one or more translation chunks failed
  9  INVALID_CONFIG  — .loqui.json is missing required fields or has invalid values
  10 TRUNCATED       — the engine hit its output token limit mid-response
  11 INVALID_USAGE   — invalid command-line usage
`.trim();

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { EXIT_CODES, LoquiError } from './errors.js';
import { translate } from './lib.js';
import { CONFIG_DEFAULTS, DEFAULT_MODELS, type LoquiConfig, type SupportedEngine } from './types.js';
import { logger } from './utils/logger.js';

const VALUE_FLAGS = new Set([
  '--input',
  '--config',
  '--from',
  '--to',
  '--engine',
  '--model',
  '--context',
  '--output',
  '--namespace',
  '--hash-file',
  '--translation-memory-file',
]);

const BOOLEAN_FLAGS = new Set([
  '--incremental',
  '--translation-memory',
  '--dry-run',
  '--diff',
  '--validate',
  '--force',
  '--help',
  '-h',
]);

/** Suggests the closest known flag, so a typo names its own fix. */
export function unknownFlag(token: string, reason = 'unknown option'): LoquiError {
  const name = token.split('=')[0];
  const known = [...VALUE_FLAGS, ...BOOLEAN_FLAGS];
  const suggestion = known.find((flag) => isNearMiss(flag, name));
  const hint = suggestion ? ` Did you mean ${suggestion}?` : ' Run loqui --help for the full list.';
  return new LoquiError('INVALID_USAGE', `${reason}: ${token}.${hint}`);
}

/** One edit apart, ignoring the leading dashes — enough to catch a typo, not a guess. */
function isNearMiss(candidate: string, typed: string): boolean {
  const a = candidate.replace(/^-+/, '');
  const b = typed.replace(/^-+/, '');
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return false;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === longer.length) {
    let diffs = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] !== longer[i]) diffs++;
      if (diffs > 1) return false;
    }
    return diffs === 1;
  }

  // one insertion: the shorter string must be the longer one with a character dropped
  for (let i = 0; i < longer.length; i++) {
    if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return true;
  }
  return false;
}

export interface Args {
  input: string | null;
  config: string | null;
  from: string | null;
  to: string | null;
  engine: string | null;
  model: string | null;
  context: string | null;
  output: string | null;
  namespace: string | null;
  hashFile: string | null;
  translationMemoryFile: string | null;
  incremental: boolean;
  translationMemory: boolean;
  dryRun: boolean;
  diff: boolean;
  validate: boolean;
  force: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const tokens = argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (!token.startsWith('-')) {
      // `--to fr de` leaves `de` here; taking only the first would drop it without a word.
      if (positional.length > 0) {
        throw new LoquiError(
          'INVALID_USAGE',
          `unexpected argument: ${token}. Only one input is accepted; pass several locales as --to fr,de.`,
        );
      }
      positional.push(token);
      continue;
    }

    // --from=en is the same flag as --from en
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);

    if (VALUE_FLAGS.has(name)) {
      if (eq !== -1) {
        flags[name] = token.slice(eq + 1);
        continue;
      }
      // A known flag in the value slot means the value was forgotten. Anything else,
      // dashes included, is a value: `--context --not-a-flag` stays legal.
      const next = tokens[i + 1];
      if (next === undefined || VALUE_FLAGS.has(next) || BOOLEAN_FLAGS.has(next)) {
        throw new LoquiError('INVALID_USAGE', `${name} needs a value.`);
      }
      flags[name] = next;
      i++;
      continue;
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw unknownFlag(token, `${name} takes no value`);
      flags[name] = 'true';
      continue;
    }

    // Silently accepting this is what makes a typo expensive: `--incremetal` would
    // be ignored and the whole file re-translated at full price.
    throw unknownFlag(token);
  }

  // The positional would be ignored, so `--input en.json --to fr de` would lose `de`.
  if (flags['--input'] !== undefined && positional.length > 0) {
    throw new LoquiError(
      'INVALID_USAGE',
      `unexpected argument: ${positional[0]}. --input already names the input; pass several locales as --to fr,de.`,
    );
  }

  return {
    input: flags['--input'] ?? positional[0] ?? null,
    config: flags['--config'] ?? null,
    from: flags['--from'] ?? null,
    to: flags['--to'] ?? null,
    engine: flags['--engine'] ?? null,
    model: flags['--model'] ?? null,
    context: flags['--context'] ?? null,
    output: flags['--output'] ?? null,
    namespace: flags['--namespace'] ?? null,
    hashFile: flags['--hash-file'] ?? null,
    translationMemoryFile: flags['--translation-memory-file'] ?? null,
    incremental: '--incremental' in flags,
    translationMemory: '--translation-memory' in flags,
    dryRun: '--dry-run' in flags,
    diff: '--diff' in flags,
    validate: '--validate' in flags,
    force: '--force' in flags,
    help: '--help' in flags || '-h' in flags,
  };
}

/** A readable stream plus the TTY flag the CLI branches on. */
export type InputStream = NodeJS.ReadableStream & { isTTY?: boolean };

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

const API_KEY_VAR: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export interface InitIO {
  /** injectable stdin — tests drive the wizard with a stream instead of a terminal. */
  input?: InputStream;
  output?: NodeJS.WritableStream;
  /** directory that receives .loqui.json. Defaults to the working directory. */
  cwd?: string;
}

export async function runInit({ input = process.stdin, output = process.stdout, cwd }: InitIO = {}): Promise<void> {
  if (!input.isTTY) {
    throw new LoquiError('INVALID_USAGE', 'loqui init must be run in an interactive terminal.');
  }

  const configPath = path.resolve(cwd ?? process.cwd(), '.loqui.json');

  // Use a single readline interface throughout so stdin is never closed mid-session
  const rl = createInterface({ input, output });
  const ask = async (prompt: string, fallback = ''): Promise<string> => {
    const raw = (await rl.question(prompt)).trim();
    return raw || fallback;
  };

  if (fs.existsSync(configPath)) {
    const answer = (await rl.question('\n  .loqui.json already exists. Overwrite? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      rl.close();
      output.write('  Aborted.\n');
      return;
    }
  }

  output.write("\n  Welcome to loqui — let's set up your config.\n\n");

  const engine = await ask('  Engine [gemini / openai / anthropic] (gemini): ', 'gemini');
  if (!['gemini', 'openai', 'anthropic'].includes(engine)) {
    rl.close();
    throw new LoquiError('INVALID_USAGE', `Unknown engine: "${engine}". Must be gemini, openai, or anthropic.`);
  }

  const defaultModel = DEFAULT_MODELS[engine as SupportedEngine] ?? 'gemini-2.5-flash';
  const model = await ask(`  Model (${defaultModel}): `, defaultModel);
  const from = await ask('  Source locale (en): ', 'en');
  const toRaw = await ask('  Target locales, comma-separated (fr,de,es): ', 'fr,de,es');
  const to = toRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const context = await ask('  Project context — helps the LLM pick the right tone (optional): ', '');

  rl.close();

  const config: Partial<LoquiConfig> = {
    engine: engine as LoquiConfig['engine'],
    model,
    from,
    to,
    temperature: CONFIG_DEFAULTS.temperature,
    topP: CONFIG_DEFAULTS.topP,
    concurrency: CONFIG_DEFAULTS.concurrency,
    splitToken: CONFIG_DEFAULTS.splitToken,
  };
  if (context) config.context = context;

  const json = `${JSON.stringify({ $schema: './node_modules/@mihairo/loqui/loqui.schema.json', ...config }, null, 2)}\n`;
  fs.writeFileSync(configPath, json, 'utf-8');

  output.write(`\n  Created .loqui.json\n\n`);
  output.write(`  Next step — set your API key:\n`);
  output.write(`    export ${API_KEY_VAR[engine]}=your-key-here\n\n`);
  output.write(`  Then translate:\n`);
  output.write(`    loqui --input en.json --output ./i18n/{locale}.json --incremental\n\n`);
}

export interface CliIO {
  /** injectable stdin — tests drive the CLI with a stream instead of a terminal. */
  stdin?: InputStream;
  /** where results go. Diagnostics never come here; they go to the logger, on stderr. */
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

  logger.header('[loqui] i18n translator');

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

  if (args.dryRun) logger.warn('Dry-run mode — no API calls or file writes.');
  if (args.force) logger.warn('Force mode — all keys will be re-translated.');

  // collect inline overrides — these take priority over the config file
  const configOverrides: Partial<LoquiConfig> = {};
  if (args.engine) configOverrides.engine = args.engine as LoquiConfig['engine'];
  if (args.model) configOverrides.model = args.model;
  if (args.context) configOverrides.context = args.context;

  const result = await translate({
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
    diff: args.diff,
    validate: args.validate,
    force: args.force,
    config: Object.keys(configOverrides).length > 0 ? configOverrides : undefined,
  });

  if (args.diff) return;

  if (args.validate) return;

  if (!args.output) {
    const locales = Object.keys(result);
    stdout.write(locales.length === 1 ? result[locales[0]] : `${JSON.stringify(result, null, 2)}\n`);
  } else {
    logger.success(`Done. Wrote ${Object.keys(result).length} locale file(s).`);
  }
}

/**
 * Runs the CLI and maps a LoquiError to its documented exit code.
 * Separated from `main` so tests can drive `main` without the process-exiting wrapper.
 */
export function run(): void {
  main().catch((err) => {
    logger.error(err.message ?? String(err));
    const code = err instanceof LoquiError ? EXIT_CODES[err.code] : 1;
    process.exit(code);
  });
}
