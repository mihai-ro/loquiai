import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig } from './config.js';
import { diffLocales } from './diff.js';
import { LoquiError } from './errors.js';
import { buildGlossaryModel } from './glossary.js';
import { loadHashStore, saveHashStore } from './hasher.js';
import { loadTranslationMemory, saveTranslationMemory } from './translation-memory.js';
import { translateJson } from './translator.js';
import type {
  EngineAdapter,
  FlatDocument,
  FlatTranslations,
  HashStore,
  LoquiConfig,
  RunStats,
  TranslationChunk,
  TranslationMemory,
  TranslationResult,
} from './types.js';
import { deepSortKeys, flatten, readJson, unflatten, withStrings, writeFileAtomic } from './utils/json.js';
import { logger } from './utils/logger.js';
import { validateLocales } from './validate.js';

export { BaseEngine } from './engines/base.engine.js';
export { createEngine } from './engines/factory.js';
export type { LoquiErrorCode } from './errors.js';
export { LoquiError } from './errors.js';
export type {
  EngineAdapter,
  FlatTranslations,
  LoquiConfig,
  RunStats,
  TranslationChunk,
  TranslationMemory,
  TranslationResult,
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
  translationMemory?: boolean;
  translationMemoryFile?: string;
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
 * @throws If any translation chunk fails after all retries. The error's `partial` holds the
 *   locale → JSON string map of whatever did translate, when anything did.
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
  // re-validate the merged result: loadConfig only validated the file, so inline
  // overrides (glossary, engine, ...) would otherwise reach the run unchecked.
  if (options.config) validateConfig(config, 'inline config');

  const from = options.from ?? config.from;
  if (!from) throw new LoquiError('INVALID_CONFIG', "'from' (source locale) is required. Set it in options or config.");

  const toRaw = options.to ?? config.to;
  if (!toRaw || (Array.isArray(toRaw) && toRaw.length === 0)) {
    throw new LoquiError('INVALID_CONFIG', "'to' (target locale(s)) is required. Set it in options or config.");
  }
  const to = Array.isArray(toRaw) ? toRaw : toRaw.split(',').map((s) => s.trim());

  // resolve input
  const isRawJson = options.input.trimStart().startsWith('{');
  const inputPath = isRawJson ? null : path.resolve(options.input);
  const inputJson = isRawJson ? options.input : fs.readFileSync(path.resolve(options.input), 'utf-8');

  const namespace =
    options.namespace ?? (inputPath ? path.basename(inputPath, path.extname(inputPath)) : 'translation');

  let sourceDoc: FlatDocument;
  let inlineGlossaryTerms: Record<string, Record<string, string>> | undefined;
  // Only strip the inline `glossary` key when the feature is active and no external path is set.
  // Without this gate, any namespace legitimately named "glossary" would be silently deleted.
  const useInlineGlossary = Boolean(config.glossary) && !config.glossary?.path;
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    if (useInlineGlossary && parsed && typeof parsed === 'object' && 'glossary' in parsed) {
      const raw = parsed.glossary;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        inlineGlossaryTerms = raw as Record<string, Record<string, string>>;
      }
      delete parsed.glossary;
    }
    sourceDoc = flatten(parsed);
  } catch {
    throw new LoquiError('PARSE_ERROR', 'Failed to parse input as JSON. Make sure it is a valid JSON object.');
  }

  // resolve output paths
  const outputPaths = resolveOutputPaths(options.output, to, inputPath);

  const sourceFlat = sourceDoc.strings;

  // load existing translations (for missing-key detection)
  const existing: Record<string, FlatTranslations> = {};
  // the target file's own structure, so anything it holds that the source does not survives a rewrite
  const existingDocs: Record<string, FlatDocument> = {};
  for (const locale of to) {
    const dest = outputPaths?.[locale];
    if (dest && fs.existsSync(dest)) {
      const doc = flatten(readJson(dest) as Record<string, unknown>);
      existingDocs[locale] = doc;
      existing[locale] = doc.strings;
    }
  }

  // Resolved before diff mode, which reads the store to tell a changed source from
  // a translated value. Read only when a mode uses it: a corrupt sidecar the run
  // never consults must not fail it.
  const useIncremental = options.incremental || Boolean(options.hashFile);
  const hashFilePath =
    options.hashFile ??
    (inputPath
      ? path.join(path.dirname(inputPath), `.${path.basename(inputPath, path.extname(inputPath))}.loqui-hash.json`)
      : null);
  const hashStore: HashStore = hashFilePath && (options.diff || useIncremental) ? loadHashStore(hashFilePath) : {};

  // Diff mode: compare and report without translating
  if (options.diff) {
    if (Object.keys(hashStore).length === 0) {
      logger.warn(
        'No hash sidecar found — "changed" cannot be reported. Run once with --incremental to start recording source hashes.',
      );
    }
    const results = diffLocales(sourceFlat, existing, hashStore);
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

  // load translation memory if enabled
  const useTranslationMemory = options.translationMemory || Boolean(options.translationMemoryFile);
  const tmFilePath =
    options.translationMemoryFile ??
    (inputPath
      ? path.join(path.dirname(inputPath), `.${path.basename(inputPath, path.extname(inputPath))}.loqui-tm.json`)
      : null);
  const translationMemory: TranslationMemory =
    useTranslationMemory && tmFilePath ? loadTranslationMemory(tmFilePath) : {};

  const glossaryModel = buildGlossaryModel(
    config.glossary,
    inlineGlossaryTerms,
    to,
    inputPath ? path.dirname(inputPath) : process.cwd(),
  );

  const { translations, updatedHashStore, updatedTranslationMemory, stats, failure } = await translateJson({
    sourceFlat,
    from,
    to,
    namespace,
    config,
    existing,
    hashStore: useIncremental ? hashStore : undefined,
    translationMemory: useTranslationMemory ? translationMemory : undefined,
    glossaryModel: glossaryModel ?? undefined,
    force: options.force,
    dryRun: options.dryRun,
    engine: options.engine,
  });

  logStats(stats);

  // serialize results
  const result: Record<string, string> = {};
  for (const [locale, flat] of Object.entries(translations)) {
    const doc = withStrings(sourceDoc, flat, existingDocs[locale]);
    result[locale] = `${JSON.stringify(deepSortKeys(unflatten(doc)), null, 2)}\n`;
  }

  // A run that failed without translating anything has nothing to persist. Writing
  // anyway would create locale files holding only the source's non-string values,
  // and would prune the hash sidecar on the strength of a run that never happened.
  const nothingLanded = failure !== undefined && stats.keysTranslated === 0;

  // write output files
  if (outputPaths && !options.dryRun && !nothingLanded) {
    for (const [locale, dest] of Object.entries(outputPaths)) {
      if (result[locale] !== undefined) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        writeFileAtomic(dest, result[locale]);
      }
    }
  }

  // persist hash store
  if (useIncremental && hashFilePath && !options.dryRun && !nothingLanded) {
    saveHashStore(hashFilePath, updatedHashStore);
  }

  // persist translation memory
  if (useTranslationMemory && tmFilePath && !options.dryRun && !nothingLanded) {
    saveTranslationMemory(tmFilePath, updatedTranslationMemory);
  }

  // Raised only after everything that succeeded has been written, so a partial run
  // still leaves its output on disk and the next run resumes from the gap.
  if (failure) throw completeFailure(failure, nothingLanded ? undefined : result, outputPaths !== null);

  return result;
}

/**
 * The translator cannot tell whether its output was written, so the message is finished
 * here, and the partial result rides on the error for callers that wrote nothing.
 * An engine error that failed every chunk keeps its own message: a caller acts on it.
 */
function completeFailure(
  failure: LoquiError,
  partial: Record<string, string> | undefined,
  wroteOutput: boolean,
): LoquiError {
  if (failure.code !== 'CHUNK_FAILED') {
    return partial ? new LoquiError(failure.code, failure.message, { cause: failure, partial }) : failure;
  }
  let outcome = 'Nothing succeeded, so there is nothing to write.';
  if (partial) {
    outcome = wroteOutput
      ? 'Output for the chunks that succeeded was written to disk; re-run to retry the rest.'
      : 'No output path is set, so nothing was saved. Set one to keep partial results; API callers can read error.partial.';
  }
  return new LoquiError('CHUNK_FAILED', `${failure.message} ${outcome}`, { cause: failure.cause, partial });
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
  if (stats.failedChunks > 0) {
    logger.warn(`${stats.failedChunks} chunk(s) failed — the keys they carried were not translated.`);
  }
  if (stats.keysTranslated > 0 || stats.warnings.length > 0) {
    logger.dim(
      `keys translated: ${stats.keysTranslated} | requests: ${stats.apiRequests} | ${(stats.elapsedMs / 1000).toFixed(1)}s`,
    );
  }
  for (const w of stats.warnings) {
    logger.warn(w);
  }
}
