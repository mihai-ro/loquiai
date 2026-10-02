import { translateFile } from './translate-file.js';
import type {
  EngineAdapter,
  FlatTranslations,
  GlossaryModel,
  HashStore,
  JsonObject,
  LoquiConfig,
  ObjectRun,
  RunStats,
  TranslateResult,
  TranslationChunk,
  TranslationMemory,
  TranslationResult,
  TranslationRun,
} from './types.js';
import type { LogFn } from './utils/logger.js';

export type { DiffResult } from './diff.js';
export { BaseEngine } from './engines/base.engine.js';
export { createEngine } from './engines/factory.js';
export type { LoquiErrorCode } from './errors.js';
export { LoquiError } from './errors.js';
export type { DiffReport, InspectOptions } from './inspect.js';
export { diff, validate } from './inspect.js';
export type { TranslateObjectOptions } from './translate-object.js';
export { translateObject } from './translate-object.js';
export type { LogFn, LogLevel } from './utils/logger.js';
export { stderrLogger } from './utils/logger.js';
export type { ValidationResult } from './validate.js';
export type {
  EngineAdapter,
  FlatTranslations,
  GlossaryModel,
  HashStore,
  JsonObject,
  LoquiConfig,
  ObjectRun,
  RunStats,
  TranslateResult,
  TranslationChunk,
  TranslationMemory,
  TranslationResult,
  TranslationRun,
};

export interface TranslateOptions {
  /**
   * Source to translate. Either a file path or a raw JSON string.
   * Auto-detected: strings starting with '{' are treated as JSON, otherwise as a path.
   */
  input: string;
  /** Source locale. Overrides config.from. */
  from?: string;
  /** Target locale(s). Overrides config.to. */
  to?: string | string[];
  /**
   * Namespace label used in prompts for translation context.
   * Auto-derived from the input filename stem if omitted.
   */
  namespace?: string;
  /**
   * Where to write outputs.
   * - string: path template with `{locale}` token, e.g. `./i18n/{locale}.json`
   * - Record: explicit path per locale, e.g. `{ es: './i18n/es.json' }`
   * If omitted, results are only returned (not written to disk).
   */
  output?: string | Record<string, string>;
  /**
   * Enable hash-based incremental translation: only keys that are new or whose
   * source text changed since the last run will be sent to the engine.
   * Hash sidecar is stored next to the input file as `.{name}.loqui-hash.json`,
   * or at the path specified by hashFile.
   */
  incremental?: boolean;
  /** Explicit path for the hash sidecar file. Implies incremental. */
  hashFile?: string;
  translationMemory?: boolean;
  translationMemoryFile?: string;
  force?: boolean;
  /** Preview without calling the API or writing files. */
  dryRun?: boolean;
  /** Custom engine — bypasses config.engine. */
  engine?: EngineAdapter;
  /**
   * Receives the run's progress, retries and warnings. Without one the run writes
   * nothing to any stream. Pass `stderrLogger` to print them as the CLI does.
   */
  logger?: LogFn;
  /** Inline config merged over any config file found. */
  config?: Partial<LoquiConfig>;
  /**
   * Path to a config file or directory containing one.
   * - file: `./configs/prod.json` — loaded directly
   * - directory: `./project` — searches for `.loqui.json` / `.i18nrc.json`
   * Defaults to process.cwd().
   */
  configPath?: string;
}

/**
 * Translate a JSON file or string into one or more target locales.
 *
 * @param options - Translation options. `input`, `from`, and `to` are required
 *   (either directly or via a loaded config file).
 * @returns One document per target locale in `locales`, the run's `stats` and the keys
 *   it pruned in `removed`. If `output` is specified, files are also written to disk and
 *   `written` names them.
 * @throws If `from` or `to` are not provided (directly or via config).
 * @throws If the input cannot be parsed as JSON.
 * @throws If any translation chunk fails after all retries. The error's `result` holds
 *   whatever did translate, and `result.written` the files saved before it gave up.
 *
 * @example
 * import { translate } from '@mihairo/loqui';
 *
 * const { locales } = await translate({
 *   input: './en.json',
 *   from: 'en',
 *   to: ['es', 'de'],
 *   output: './i18n/{locale}.json',
 *   incremental: true,
 * });
 */
export function translate(options: TranslateOptions): Promise<TranslateResult> {
  return translateFile(options);
}
