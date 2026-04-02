import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { diffLocales } from './diff.js';
import { loadGlossary, saveGlossary } from './glossary.js';
import { loadHashStore, saveHashStore } from './hasher.js';
import { translateJson } from './translator.js';
import type {
  EngineAdapter,
  FlatTranslations,
  Glossary,
  HashStore,
  LoquiConfig,
  RunStats,
  TranslationChunk,
  TranslationResult,
} from './types.js';
import { deepSortKeys, flatten, readJson, unflatten } from './utils/json.js';
import { logger } from './utils/logger.js';
import { validateLocales } from './validate.js';

export { BaseEngine } from './engines/base.engine.js';
export { createEngine } from './engines/factory.js';
export type { EngineAdapter, FlatTranslations, Glossary, LoquiConfig, RunStats, TranslationChunk, TranslationResult };

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
   * - Record: explicit path per locale, e.g. `{ fr: './i18n/fr.json' }`
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
  glossary?: boolean;
  glossaryFile?: string;
  force?: boolean;
  /** Preview without calling the API or writing files. */
  dryRun?: boolean;
  diff?: boolean;
  validate?: boolean;
  /** Custom engine — bypasses config.engine. */
  engine?: EngineAdapter;
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
 * @returns A map of `locale → JSON string` with the translated content.
 *   If `output` is specified, files are also written to disk.
 * @throws If `from` or `to` are not provided (directly or via config).
 * @throws If the input cannot be parsed as JSON.
 * @throws If any translation chunk fails after all retries.
 *
 * @example
 * import { translate } from '@mihairo/loqui';
 *
 * const results = await translate({
 *   input: './en.json',
 *   from: 'en',
 *   to: ['fr', 'de'],
 *   output: './i18n/{locale}.json',
 *   incremental: true,
 * });
 */
export async function translate(options: TranslateOptions): Promise<Record<string, string>> {
  const fileConfig = loadConfig(options.configPath);
  // inline config takes priority over file config
  const config: LoquiConfig = options.config ? { ...fileConfig, ...options.config } : fileConfig;

  const from = options.from ?? config.from;
  if (!from) throw new Error("'from' (source locale) is required. Set it in options or config.");

  const toRaw = options.to ?? config.to;
  if (!toRaw || (Array.isArray(toRaw) && toRaw.length === 0)) {
    throw new Error("'to' (target locale(s)) is required. Set it in options or config.");
  }
  const to = Array.isArray(toRaw) ? toRaw : toRaw.split(',').map((s) => s.trim());

  // resolve input
  const isRawJson = options.input.trimStart().startsWith('{');
  const inputPath = isRawJson ? null : path.resolve(options.input);
  const inputJson = isRawJson ? options.input : fs.readFileSync(path.resolve(options.input), 'utf-8');

  const namespace =
    options.namespace ?? (inputPath ? path.basename(inputPath, path.extname(inputPath)) : 'translation');

  let sourceFlat: ReturnType<typeof flatten>;
  try {
    sourceFlat = flatten(JSON.parse(inputJson) as Record<string, unknown>);
  } catch {
    throw new Error(`Failed to parse input as JSON. Make sure it is a valid JSON object.`);
  }

  // resolve output paths
  const outputPaths = resolveOutputPaths(options.output, to, inputPath);

  // load existing translations (for missing-key detection)
  const existing: Record<string, FlatTranslations> = {};
  for (const locale of to) {
    const dest = outputPaths?.[locale];
    if (dest && fs.existsSync(dest)) {
      existing[locale] = flatten(readJson(dest) as Record<string, unknown>);
    }
  }

  // Diff mode: compare and report without translating
  if (options.diff) {
    const results = diffLocales(sourceFlat, existing);
    for (const r of results) {
      logger.info(`[${r.locale}]`);
      for (const key of r.added) logger.info(`  + ${key}`);
      for (const key of r.removed) logger.info(`  - ${key}`);
      for (const key of r.changed) logger.info(`  ~ ${key}`);
      logger.dim(
        `Summary: ${r.added.length} added, ${r.removed.length} removed, ${r.changed.length} changed, ${r.unchanged.length} unchanged`,
      );
    }
    return {};
  }

  if (options.validate) {
    if (Object.keys(existing).length === 0) {
      logger.warn('No existing translation files found to validate.');
      return {};
    }
    const results = validateLocales(sourceFlat, existing);
    let totalMissing = 0;
    let totalExtra = 0;
    let totalOk = 0;
    for (const r of results) {
      logger.info(`[${r.locale}]`);
      for (const key of r.missing) {
        logger.error(`  ✗ missing: ${key}`);
        totalMissing++;
      }
      for (const key of r.extra) {
        logger.error(`  ✗ extra: ${key}`);
        totalExtra++;
      }
      totalOk += r.ok.length;
    }
    logger.dim(`Summary: ${totalMissing} missing, ${totalExtra} extra, ${totalOk} ok`);
    if (totalMissing > 0 || totalExtra > 0) {
      process.exitCode = 1;
    }
    return {};
  }

  // load hash store if incremental
  const useIncremental = options.incremental || Boolean(options.hashFile);
  const hashFilePath =
    options.hashFile ??
    (inputPath
      ? path.join(path.dirname(inputPath), `.${path.basename(inputPath, path.extname(inputPath))}.loqui-hash.json`)
      : null);
  const hashStore: HashStore = useIncremental && hashFilePath ? loadHashStore(hashFilePath) : {};

  // load glossary if enabled
  const useGlossary = options.glossary || Boolean(options.glossaryFile);
  const glossaryFilePath =
    options.glossaryFile ??
    (inputPath
      ? path.join(path.dirname(inputPath), `.${path.basename(inputPath, path.extname(inputPath))}.loqui-glossary.json`)
      : null);
  const glossary: Glossary = useGlossary && glossaryFilePath ? loadGlossary(glossaryFilePath) : {};

  const { translations, updatedHashStore, updatedGlossary, stats } = await translateJson({
    sourceFlat,
    from,
    to,
    namespace,
    config,
    existing,
    hashStore: useIncremental ? hashStore : undefined,
    glossary: useGlossary ? glossary : undefined,
    glossaryPath: glossaryFilePath ?? undefined,
    force: options.force,
    dryRun: options.dryRun,
    engine: options.engine,
  });

  logStats(stats);

  // serialize results
  const result: Record<string, string> = {};
  for (const [locale, flat] of Object.entries(translations)) {
    result[locale] = `${JSON.stringify(deepSortKeys(unflatten(flat) as Record<string, unknown>), null, 2)}\n`;
  }

  // write output files
  if (outputPaths && !options.dryRun) {
    for (const [locale, dest] of Object.entries(outputPaths)) {
      if (result[locale] !== undefined) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, result[locale], 'utf-8');
      }
    }
  }

  // persist hash store
  if (useIncremental && hashFilePath && !options.dryRun) {
    saveHashStore(hashFilePath, updatedHashStore);
  }

  // persist glossary
  if (useGlossary && glossaryFilePath && !options.dryRun) {
    saveGlossary(glossaryFilePath, updatedGlossary);
  }

  return result;
}

function resolveOutputPaths(
  output: TranslateOptions['output'],
  to: string[],
  _inputPath: string | null,
): Record<string, string> | null {
  if (!output) return null;

  if (typeof output === 'object') return output;

  // string: treat as template if it contains {locale}, otherwise as a directory
  if (output.includes('{locale}')) {
    return Object.fromEntries(to.map((locale) => [locale, output.replace('{locale}', locale)]));
  }

  // plain directory path: write {dir}/{locale}.json
  return Object.fromEntries(to.map((locale) => [locale, path.join(output, `${locale}.json`)]));
}

function logStats(stats: RunStats): void {
  if (stats.keysTranslated > 0 || stats.warnings.length > 0) {
    process.stderr.write(
      `\x1b[2m keys translated: ${stats.keysTranslated} | requests: ${stats.apiRequests} | ${(stats.elapsedMs / 1000).toFixed(1)}s\x1b[0m\n`,
    );
  }
  for (const w of stats.warnings) {
    process.stderr.write(`\x1b[33m[❗️] ${w}\x1b[0m\n`);
  }
}
