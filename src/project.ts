import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig, validateTargets } from './config.js';
import { LoquiError } from './errors.js';
import type { FlatTranslations, JsonObject, LoquiConfig } from './types.js';
import { assertJsonObject, flatten, readJson } from './utils/json.js';

/**
 * The loading `translate()`, `diff()` and `validate()` share: the config, the source, the
 * target paths and the target files already on disk. One copy, so the three cannot
 * disagree about what a path template or an inline glossary key means.
 */

export type OutputOption = string | Record<string, string>;

/** The config file merged with inline overrides, validated. */
export function resolveConfig(configPath: string | undefined, inline: Partial<LoquiConfig> | undefined): LoquiConfig {
  const fileConfig = loadConfig(configPath);
  // inline config takes priority over file config
  const config: LoquiConfig = inline ? { ...fileConfig, ...inline } : fileConfig;
  // re-validate the merged result: loadConfig only validated the file, so inline
  // overrides (glossary, engine, ...) would otherwise reach the run unchecked.
  if (inline) validateConfig(config, 'inline config');
  return config;
}

/** The target locales, from the options or else the config. */
export function resolveTargets(to: string | string[] | undefined, config: LoquiConfig): string[] {
  const raw = to ?? config.to;
  if (!raw || (Array.isArray(raw) && raw.length === 0)) {
    throw new LoquiError('INVALID_CONFIG', "'to' (target locale(s)) is required. Set it in options or config.");
  }
  const targets = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim());
  validateTargets(targets);
  return targets;
}

export interface LoadedSource {
  /** null when the input was a raw JSON string. */
  inputPath: string | null;
  /** the document, without an inline `glossary` key when that feature is on. */
  source: JsonObject;
  sourceFlat: FlatTranslations;
  inlineGlossaryTerms?: Record<string, Record<string, string>>;
}

/** Reads the input, a file path or a raw JSON string. */
export function loadSource(input: string, config: LoquiConfig): LoadedSource {
  const isRawJson = input.trimStart().startsWith('{');
  const inputPath = isRawJson ? null : path.resolve(input);
  const inputJson = isRawJson ? input : readInputFile(path.resolve(input));

  let inlineGlossaryTerms: Record<string, Record<string, string>> | undefined;
  // Only strip the inline `glossary` key when the feature is active and no external path is set.
  // Without this gate, any namespace legitimately named "glossary" would be silently deleted.
  const useInlineGlossary = Boolean(config.glossary) && !config.glossary?.path;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    throw new LoquiError('PARSE_ERROR', 'Failed to parse input as JSON. Make sure it is a valid JSON object.');
  }
  const source = assertJsonObject(parsed, inputPath ?? 'The input') as JsonObject;
  if (useInlineGlossary && 'glossary' in source) {
    const raw = source.glossary;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      inlineGlossaryTerms = raw as Record<string, Record<string, string>>;
    }
    delete source.glossary;
  }
  return { inputPath, source, sourceFlat: flatten(source).strings, inlineGlossaryTerms };
}

function readInputFile(inputPath: string): string {
  try {
    return fs.readFileSync(inputPath, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new LoquiError('INPUT_NOT_FOUND', `The input file does not exist: ${inputPath}`, { cause: err });
    }
    throw err;
  }
}

/** locale → target file path, or null when there is no output. */
export function resolveOutputPaths(output: OutputOption | undefined, to: string[]): Record<string, string> | null {
  if (!output) return null;

  if (typeof output === 'object') return output;

  // string: treat as template if it contains {locale}, otherwise as a directory
  if (output.includes('{locale}')) {
    return Object.fromEntries(to.map((locale) => [locale, output.replaceAll('{locale}', locale)]));
  }

  // plain directory path: write {dir}/{locale}.json
  return Object.fromEntries(to.map((locale) => [locale, path.join(output, `${locale}.json`)]));
}

/**
 * Every target locale needs a path. One left out of an output record would be skipped
 * without a word: billed and never written by `translate()`, never checked by `validate()`.
 */
export function assertEveryLocaleMapped(outputPaths: Record<string, string>, to: string[]): void {
  const unmapped = to.filter((locale) => !Object.hasOwn(outputPaths, locale));
  if (unmapped.length > 0) {
    throw new LoquiError(
      'INVALID_CONFIG',
      `'output' has no path for target locale(s): ${unmapped.join(', ')}. Add one for each, or use a '{locale}' template.`,
    );
  }
}

/** The target files that exist, parsed. A locale without a file is absent. */
export function loadExisting(outputPaths: Record<string, string> | null, to: string[]): Record<string, JsonObject> {
  const existing: Record<string, JsonObject> = {};
  for (const locale of to) {
    const dest = outputPaths?.[locale];
    if (dest && fs.existsSync(dest)) existing[locale] = readJson(dest);
  }
  return existing;
}

/** Where a sidecar lives: the given path, else next to the input file. null for a raw JSON input. */
export function sidecarPath(
  inputPath: string | null,
  explicit: string | undefined,
  kind: 'hash' | 'tm',
): string | null {
  if (explicit) return explicit;
  if (!inputPath) return null;
  const stem = path.basename(inputPath, path.extname(inputPath));
  return path.join(path.dirname(inputPath), `.${stem}.loqui-${kind}.json`);
}

/** The strings of each document, the shape `diff` and `validate` compare. */
export function stringsOf(docs: Record<string, JsonObject>): Record<string, FlatTranslations> {
  return Object.fromEntries(Object.entries(docs).map(([locale, doc]) => [locale, flatten(doc).strings]));
}
