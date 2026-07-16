import fs from 'node:fs';
import path from 'node:path';
import { LoquiError } from './errors.js';
import { CONFIG_DEFAULTS, type LoquiConfig } from './types.js';

const CONFIG_FILE = '.loqui.json';

const KNOWN_KEYS = new Set([
  '$schema',
  'engine',
  'model',
  'from',
  'to',
  'temperature',
  'topP',
  'concurrency',
  'splitToken',
  'context',
  'prompts',
  'placeholderPatterns',
  'timeout',
  'review',
  'glossary',
]);

const KNOWN_PROMPT_KEYS = new Set(['system', 'user']);
const KNOWN_GLOSSARY_KEYS = new Set(['path', 'noTranslate']);

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
    throw new LoquiError('INVALID_CONFIG', `Failed to parse '${filePath}': ${(e as Error).message}`);
  }

  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    const allowed = [...KNOWN_KEYS].filter((k) => k !== '$schema').join(', ');
    throw new LoquiError(
      'INVALID_CONFIG',
      `Unknown config key(s) in '${filePath}': ${unknown.map((k) => `'${k}'`).join(', ')}. Allowed: ${allowed}`,
    );
  }

  // Strip $schema before merging — it's not a LoquiConfig field and would leak
  // into the runtime object as an untyped property.
  const { $schema: _$schema, ...rest } = raw;
  const config = { ...CONFIG_DEFAULTS, ...(rest as Partial<LoquiConfig>) };
  validateConfig(config, filePath);
  return config;
}

export function validateConfig(config: LoquiConfig, source: string): void {
  if (!['gemini', 'openai', 'anthropic'].includes(config.engine)) {
    throw new LoquiError(
      'INVALID_CONFIG',
      `'engine' must be one of: gemini, openai, anthropic. Got: '${config.engine}' in ${source}`,
    );
  }

  if (typeof config.model !== 'string' || config.model.trim() === '') {
    throw new LoquiError('INVALID_CONFIG', `'model' must be a non-empty string in ${source}`);
  }

  if (config.from !== undefined && (typeof config.from !== 'string' || config.from.trim() === '')) {
    throw new LoquiError('INVALID_CONFIG', `'from' must be a non-empty string in ${source}`);
  }

  if (config.to !== undefined) {
    if (!Array.isArray(config.to) || config.to.some((l) => typeof l !== 'string' || l.trim() === '')) {
      throw new LoquiError('INVALID_CONFIG', `'to' must be an array of non-empty locale strings in ${source}`);
    }
  }

  if (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2) {
    throw new LoquiError('INVALID_CONFIG', `'temperature' must be a number between 0 and 2 in ${source}`);
  }

  if (typeof config.topP !== 'number' || config.topP < 0 || config.topP > 1) {
    throw new LoquiError('INVALID_CONFIG', `'topP' must be a number between 0 and 1 in ${source}`);
  }

  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 32) {
    throw new LoquiError('INVALID_CONFIG', `'concurrency' must be an integer between 1 and 32 in ${source}`);
  }

  if (!Number.isInteger(config.splitToken) || config.splitToken < 500 || config.splitToken > 32000) {
    throw new LoquiError('INVALID_CONFIG', `'splitToken' must be an integer between 500 and 32000 in ${source}`);
  }

  if (config.context !== undefined && typeof config.context !== 'string') {
    throw new LoquiError('INVALID_CONFIG', `'context' must be a string in ${source}`);
  }

  if (config.prompts !== undefined) {
    if (typeof config.prompts !== 'object' || Array.isArray(config.prompts) || config.prompts === null) {
      throw new LoquiError('INVALID_CONFIG', `'prompts' must be an object in ${source}`);
    }
    const unknownPromptKeys = Object.keys(config.prompts).filter((k) => !KNOWN_PROMPT_KEYS.has(k));
    if (unknownPromptKeys.length > 0) {
      throw new LoquiError(
        'INVALID_CONFIG',
        `Unknown key(s) in 'prompts' in '${source}': ${unknownPromptKeys.map((k) => `'${k}'`).join(', ')}. Allowed: system, user`,
      );
    }
    if (config.prompts.system !== undefined && typeof config.prompts.system !== 'string') {
      throw new LoquiError('INVALID_CONFIG', `'prompts.system' must be a string in ${source}`);
    }
    if (config.prompts.user !== undefined && typeof config.prompts.user !== 'string') {
      throw new LoquiError('INVALID_CONFIG', `'prompts.user' must be a string in ${source}`);
    }
  }

  if (config.placeholderPatterns !== undefined) {
    if (!Array.isArray(config.placeholderPatterns)) {
      throw new LoquiError('INVALID_CONFIG', `'placeholderPatterns' must be an array of strings in ${source}`);
    }
    for (const pat of config.placeholderPatterns) {
      if (typeof pat !== 'string') {
        throw new LoquiError('INVALID_CONFIG', `'placeholderPatterns' items must all be strings in ${source}`);
      }
      try {
        new RegExp(pat);
      } catch {
        throw new LoquiError('INVALID_CONFIG', `'placeholderPatterns' contains invalid regex '${pat}' in ${source}`);
      }
    }
  }

  if (config.timeout !== undefined) {
    if (typeof config.timeout !== 'number' || !Number.isFinite(config.timeout) || config.timeout < 0) {
      throw new LoquiError('INVALID_CONFIG', `'timeout' must be a non-negative finite number in ${source}`);
    }
  }

  if (config.review !== undefined && typeof config.review !== 'boolean') {
    throw new LoquiError('INVALID_CONFIG', `'review' must be a boolean in ${source}`);
  }

  if (config.glossary !== undefined) {
    if (typeof config.glossary !== 'object' || Array.isArray(config.glossary) || config.glossary === null) {
      throw new LoquiError('INVALID_CONFIG', `'glossary' must be an object in ${source}`);
    }
    const unknownGlossaryKeys = Object.keys(config.glossary).filter((k) => !KNOWN_GLOSSARY_KEYS.has(k));
    if (unknownGlossaryKeys.length > 0) {
      throw new LoquiError(
        'INVALID_CONFIG',
        `Unknown key(s) in 'glossary' in '${source}': ${unknownGlossaryKeys.map((k) => `'${k}'`).join(', ')}. Allowed: path, noTranslate`,
      );
    }
    if (
      config.glossary.path !== undefined &&
      (typeof config.glossary.path !== 'string' || config.glossary.path.trim() === '')
    ) {
      throw new LoquiError('INVALID_CONFIG', `'glossary.path' must be a non-empty string in ${source}`);
    }
    if (config.glossary.noTranslate !== undefined) {
      if (
        !Array.isArray(config.glossary.noTranslate) ||
        config.glossary.noTranslate.some((s) => typeof s !== 'string')
      ) {
        throw new LoquiError('INVALID_CONFIG', `'glossary.noTranslate' must be an array of strings in ${source}`);
      }
    }
  }
}
