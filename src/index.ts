#!/usr/bin/env node

/**
 * loqui — i18n translation CLI
 *
 * Usage:
 *   loqui [input] [options]
 *
 *   [input] — one of:
 *     --input <file>         read from a JSON file
 *     --input '<json>'       pass a JSON string inline
 *     first positional arg   loqui '{"key":"val"}' --from en --to fr
 *     stdin                  cat en.json | loqui --from en --to fr
 *
 * Options:
 *   --config <path>        Config file or directory (default: .loqui.json in cwd)
 *   --from <locale>        Source locale — overrides config.from
 *   --to <locale,...>      Target locale(s), comma-separated — overrides config.to
 *   --engine <name>        Engine: gemini | openai | anthropic — overrides config.engine
 *   --model <name>         Model name — overrides config.model
 *   --context <text>       Domain context injected into prompts — overrides config.context
 *   --output <path>        Output path. Use {locale} token: ./i18n/{locale}.json
 *                          Or a plain directory: writes {dir}/{locale}.json
 *   --namespace <name>     Namespace label injected into translation prompts
 *   --incremental          Only translate new/changed keys (uses a hash sidecar)
 *   --hash-file <path>     Hash sidecar path (implies --incremental)
 *   --dry-run              Preview without calling the API or writing files
 *   --force                Re-translate all keys regardless of existing translations
 *
 * Inline options always override values from the config file.
 *
 * Environment variables:
 *   GEMINI_API_KEY      — required when engine = "gemini"
 *   OPENAI_API_KEY      — required when engine = "openai"
 *   ANTHROPIC_API_KEY   — required when engine = "anthropic"
 */

import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline/promises';
import { translate } from './lib.js';
import { logger } from './utils/logger.js';
import { LoquiConfig, CONFIG_DEFAULTS } from './types.js';

const VALUE_FLAGS = new Set([
  '--input', '--config', '--from', '--to',
  '--engine', '--model', '--context',
  '--output', '--namespace', '--hash-file',
]);

interface Args {
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
  incremental: boolean;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const tokens = argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (VALUE_FLAGS.has(t)) {
      flags[t] = tokens[++i] ?? '';
    } else if (t.startsWith('--') || t.startsWith('-')) {
      flags[t] = 'true';
    } else {
      positional.push(t);
    }
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
    incremental: '--incremental' in flags,
    dryRun: '--dry-run' in flags,
    force: '--force' in flags,
    help: '--help' in flags || '-h' in flags,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

const DEFAULT_MODEL: Record<string, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
};

const API_KEY_VAR: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

async function runInit(): Promise<void> {
  if (!process.stdin.isTTY) {
    logger.error('loqui init must be run in an interactive terminal.');
    process.exit(1);
  }

  const configPath = path.resolve(process.cwd(), '.loqui.json');

  // Use a single readline interface throughout so stdin is never closed mid-session
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt: string, fallback = ''): Promise<string> => {
    const raw = (await rl.question(prompt)).trim();
    return raw || fallback;
  };

  if (fs.existsSync(configPath)) {
    const answer = (await rl.question('\n  .loqui.json already exists. Overwrite? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      rl.close();
      process.stdout.write('  Aborted.\n');
      return;
    }
  }

  process.stdout.write('\n  Welcome to loqui — let\'s set up your config.\n\n');

  const engine = await ask('  Engine [gemini / openai / anthropic] (gemini): ', 'gemini');
  if (!['gemini', 'openai', 'anthropic'].includes(engine)) {
    rl.close();
    logger.error(`Unknown engine: "${engine}". Must be gemini, openai, or anthropic.`);
    process.exit(1);
  }

  const defaultModel = DEFAULT_MODEL[engine];
  const model = await ask(`  Model (${defaultModel}): `, defaultModel);
  const from = await ask('  Source locale (en): ', 'en');
  const toRaw = await ask('  Target locales, comma-separated (fr,de,es): ', 'fr,de,es');
  const to = toRaw.split(',').map((s) => s.trim()).filter(Boolean);
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

  const json = JSON.stringify({ $schema: './node_modules/loqui/loqui.schema.json', ...config }, null, 2) + '\n';
  fs.writeFileSync(configPath, json, 'utf-8');

  process.stdout.write(`\n  Created .loqui.json\n\n`);
  process.stdout.write(`  Next step — set your API key:\n`);
  process.stdout.write(`    export ${API_KEY_VAR[engine]}=your-key-here\n\n`);
  process.stdout.write(`  Then translate:\n`);
  process.stdout.write(`    loqui --input en.json --output ./i18n/{locale}.json --incremental\n\n`);
}

async function main(): Promise<void> {
  if (process.argv[2] === 'init') {
    await runInit();
    return;
  }

  const args = parseArgs(process.argv);

  if (args.help) {
    const src = await import('fs').then((fs) => fs.promises.readFile(__filename, 'utf-8').catch(() => ''));
    const doc = src.match(/\/\*\*([\s\S]*?)\*\//)?.[1]?.replace(/^\s*\* ?/gm, '') ?? '';
    process.stdout.write(doc.trim() + '\n');
    return;
  }

  logger.header('[loqui] i18n translator');

  let input = args.input;
  if (!input) {
    if (process.stdin.isTTY) {
      logger.error('No input provided. Use --input <file|json>, a positional arg, or pipe via stdin.');
      process.exit(1);
    }
    input = await readStdin();
    if (!input) {
      logger.error('Received empty input from stdin.');
      process.exit(1);
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
    incremental: args.incremental,
    dryRun: args.dryRun,
    force: args.force,
    config: Object.keys(configOverrides).length > 0 ? configOverrides : undefined,
  });

  if (!args.output) {
    const locales = Object.keys(result);
    process.stdout.write(locales.length === 1 ? result[locales[0]] : JSON.stringify(result, null, 2) + '\n');
  } else {
    logger.success(`Done. Wrote ${Object.keys(result).length} locale file(s).`);
  }
}

main().catch((err) => {
  logger.error(err.message ?? String(err));
  process.exit(1);
});
