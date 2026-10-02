import { validateConfig } from './config.js';
import { LoquiError } from './errors.js';
import { translateJson } from './translator.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type FlatDocument,
  type GlossaryModel,
  type HashStore,
  type JsonObject,
  type LoquiConfig,
  type ObjectRun,
  type TranslationMemory,
} from './types.js';
import { deepSortKeys, flatten, unflatten, withStrings } from './utils/json.js';
import type { LogFn } from './utils/logger.js';

export interface TranslateObjectOptions {
  from: string;
  to: string[];
  /** Merged over the defaults and validated. No config file is looked up. */
  config?: Partial<LoquiConfig>;
  /** Existing target documents by locale. Keys they already translate are not sent again. */
  existing?: Record<string, JsonObject>;
  /** Source hashes from the last run. Passing them (even `{}`) turns incremental on. */
  hashes?: HashStore;
  /** Whole-string translations from earlier runs. Passing it turns translation memory on. */
  memory?: TranslationMemory;
  /** Resolved glossary terms and the do-not-translate list. */
  glossary?: GlossaryModel;
  namespace?: string;
  force?: boolean;
  /** Preview without calling the engine. */
  dryRun?: boolean;
  /** Custom engine; bypasses `config.engine`. */
  engine?: EngineAdapter;
  logger?: LogFn;
}

/**
 * Translates an in-memory document. Reads no file, writes none, and looks up no
 * config file: everything comes in as data and goes back out as data, so a caller can
 * run it anywhere and decide for itself what to persist.
 *
 * Rejects with a `LoquiError` carrying `result` when chunks failed, holding everything
 * that landed. An error raised before anything is sent carries none.
 */
export function translateObject(source: JsonObject, options: TranslateObjectOptions): Promise<ObjectRun> {
  return runObject(source, options);
}

/**
 * `translateObject` for the file layer, which has warnings of its own from preparing the
 * run (an old-format memory file). They go through the run's log, the only writer of
 * `stats.warnings`, so they are recorded and logged ahead of its progress. Not exported
 * from the package: an in-memory caller prepares nothing.
 */
export async function runObject(
  source: JsonObject,
  options: TranslateObjectOptions,
  preRunWarnings?: string[],
): Promise<ObjectRun> {
  const config: LoquiConfig = { ...CONFIG_DEFAULTS, ...options.config };
  validateConfig(config, 'config');

  const namespace = options.namespace ?? 'translation';
  const sourceDoc = flatten(source);

  const existing: Record<string, FlatDocument> = {};
  for (const [locale, doc] of Object.entries(options.existing ?? {})) existing[locale] = flatten(doc);

  const { translations, updatedHashStore, updatedTranslationMemory, stats, log, failure } = await translateJson({
    sourceFlat: sourceDoc.strings,
    from: options.from,
    to: options.to,
    namespace,
    config,
    existing: Object.fromEntries(Object.entries(existing).map(([locale, doc]) => [locale, doc.strings])),
    hashStore: options.hashes,
    // The run records into the object it is given; the caller's own must not change under it.
    translationMemory: options.memory && copyMemory(options.memory),
    glossaryModel: options.glossary,
    force: options.force,
    dryRun: options.dryRun,
    engine: options.engine,
    preRunWarnings,
    logger: options.logger ?? (() => {}),
  });

  // A target holds exactly the source's keys, so a rewrite drops the rest. A run that
  // failed without translating anything rewrites nothing, so it prunes nothing either.
  const nothingLanded = failure !== undefined && stats.keysTranslated === 0;
  const removed: Record<string, string[]> = Object.fromEntries(options.to.map((locale) => [locale, []]));
  if (!nothingLanded) {
    for (const [locale, doc] of Object.entries(existing)) {
      const dropped = [...Object.keys(doc.strings), ...Object.keys(doc.values)].filter(
        (key) => !Object.hasOwn(sourceDoc.strings, key) && !Object.hasOwn(sourceDoc.values, key),
      );
      if (dropped.length === 0) continue;
      removed[locale] = dropped;
      log(
        'warn',
        `[${namespace}→${locale}] ${options.dryRun ? 'Would remove' : 'Removed'} ${dropped.length} key(s) the source no longer has`,
      );
      for (const key of dropped) log('debug', `  - ${locale}: ${key}`);
    }
  }

  const locales: Record<string, JsonObject> = {};
  for (const [locale, flat] of Object.entries(translations)) {
    locales[locale] = deepSortKeys(unflatten(withStrings(sourceDoc, flat)));
  }

  const run: ObjectRun = { locales, stats, removed, hashes: updatedHashStore, memory: updatedTranslationMemory };
  if (failure) throw withResult(failure, run);
  return run;
}

function copyMemory(memory: TranslationMemory): TranslationMemory {
  return Object.fromEntries(Object.entries(memory).map(([key, entry]) => [key, { ...entry }]));
}

/**
 * The engine's own code and message stay: a caller acts on an AUTH. Only a failure that
 * is a mix of chunk errors keeps `CHUNK_FAILED`, whose message the file layer finishes
 * once it knows whether anything was written.
 */
function withResult(failure: LoquiError, result: ObjectRun): LoquiError {
  return new LoquiError(failure.code, failure.message, {
    cause: failure.code === 'CHUNK_FAILED' ? failure.cause : failure,
    result,
  });
}
