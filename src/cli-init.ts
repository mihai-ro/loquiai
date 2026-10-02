import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { LoquiError } from './errors.js';
import { CONFIG_DEFAULTS, DEFAULT_MODELS, type LoquiConfig, type SupportedEngine } from './types.js';

/** A readable stream plus the TTY flag the CLI branches on. */
export type InputStream = NodeJS.ReadableStream & { isTTY?: boolean };

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
  const toRaw = await ask('  Target locales, comma-separated (es,pt,de): ', 'es,pt,de');
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
