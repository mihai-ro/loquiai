import fs from 'fs';
import path from 'path';
import { CONFIG_DEFAULTS, LoquiConfig } from './types.js';

const CONFIG_FILE = '.loqui.json';

/**
 * Load config from:
 *   - a direct file path:  loadConfig('./configs/prod.json')
 *   - a directory to search: loadConfig('./project')  → finds .loqui.json
 *   - omitted: searches process.cwd()
 * Returns CONFIG_DEFAULTS if no file is found.
 */
export function loadConfig(dirOrFile?: string): LoquiConfig {
  if (!dirOrFile) return searchDir(process.cwd());

  const resolved = path.resolve(dirOrFile);
  const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;

  if (stat?.isFile()) return parseFile(resolved);
  return searchDir(resolved);
}

function searchDir(dir: string): LoquiConfig {
  const filePath = path.join(dir, CONFIG_FILE);
  if (fs.existsSync(filePath)) return parseFile(filePath);
  return { ...CONFIG_DEFAULTS };
}

function parseFile(filePath: string): LoquiConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to parse '${filePath}': ${(e as Error).message}`);
  }

  const config = { ...CONFIG_DEFAULTS, ...(raw as Partial<LoquiConfig>) };
  validateConfig(config, filePath);
  return config;
}

function validateConfig(config: LoquiConfig, source: string): void {
  if (!['gemini', 'openai', 'anthropic'].includes(config.engine)) {
    throw new Error(`'engine' must be one of: gemini, openai, anthropic. Got: '${config.engine}' in ${source}`);
  }
  if (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2) {
    throw new Error(`'temperature' must be a number between 0 and 2 in ${source}`);
  }
  if (typeof config.topP !== 'number' || config.topP < 0 || config.topP > 1) {
    throw new Error(`'topP' must be a number between 0 and 1 in ${source}`);
  }
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 32) {
    throw new Error(`'concurrency' must be an integer between 1 and 32 in ${source}`);
  }
  if (!Number.isInteger(config.splitToken) || config.splitToken < 500 || config.splitToken > 32000) {
    throw new Error(`'splitToken' must be an integer between 500 and 32000 in ${source}`);
  }
}
