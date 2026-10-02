import { chunkTranslations, processChunk } from './chunk.js';
import { ConcurrencyPool } from './concurrency-pool.js';
import { createEngine } from './engines/factory.js';
import { LoquiError } from './errors.js';
import { buildUpdatedHashStore, hashValue } from './hasher.js';
import { lookupTranslationMemory, memoryKey, updateTranslationMemory } from './translation-memory.js';
import type {
  EngineAdapter,
  FlatTranslations,
  GlossaryModel,
  HashStore,
  LoquiConfig,
  RunStats,
  TranslationMemory,
} from './types.js';
import { isUntranslated } from './untranslated.js';
import type { LogFn } from './utils/logger.js';

export interface TranslateJobOptions {
  sourceFlat: FlatTranslations;
  from: string;
  to: string[];
  namespace: string;
  config: LoquiConfig;
  existing?: Record<string, FlatTranslations>;
  hashStore?: HashStore;
  translationMemory?: TranslationMemory;
  glossaryModel?: GlossaryModel;
  force?: boolean;
  dryRun?: boolean;
  engine?: EngineAdapter;
  /** where the run's messages go. Required: a site that forgets it would log nowhere. */
  logger: LogFn;
  /** warnings raised while preparing the run (before any key is sent), logged first. */
  preRunWarnings?: string[];
}

export interface TranslateJobResult {
  translations: Record<string, FlatTranslations>;
  updatedHashStore: HashStore;
  updatedTranslationMemory: TranslationMemory;
  stats: RunStats;
  /**
   * The run's log. A caller that has something to say after the run, such as the file
   * layer's note about pruned keys, says it here so it lands in `stats.warnings` too.
   */
  log: LogFn;
  /**
   * Set when chunks failed. The caller persists what succeeded and then raises this,
   * so a partial run still leaves its output on disk.
   */
  failure?: LoquiError;
}

/**
 * The one writer of `stats.warnings`: a `warn` is recorded in the run's stats and every
 * message goes to the caller's logger, so the two can never disagree.
 */
function createRunLog(stats: RunStats, logger: LogFn): LogFn {
  return (level, message) => {
    if (level === 'warn') stats.warnings.push(message);
    logger(level, message);
  };
}

export async function translateJson(opts: TranslateJobOptions): Promise<TranslateJobResult> {
  const {
    sourceFlat,
    from,
    to,
    namespace,
    config,
    existing = {},
    hashStore = {},
    translationMemory: tmOpt,
    glossaryModel,
    force = false,
    dryRun = false,
    preRunWarnings = [],
  } = opts;

  const stats: RunStats = {
    keysTranslated: 0,
    apiRequests: 0,
    elapsedMs: 0,
    warnings: [],
    failedChunks: 0,
  };
  const log = createRunLog(stats, opts.logger);
  for (const w of preRunWarnings) log('warn', w);
  const startTime = Date.now();

  const translationMemory = tmOpt ?? {};
  let failure: LoquiError | undefined;

  // Hashes are source-derived — compute once for all keys, regardless of what needs translating.
  // This ensures the hash file is always up to date even on "nothing to do" runs.
  const currentSourceHashes: HashStore = {};
  for (const [key, value] of Object.entries(sourceFlat)) {
    currentSourceHashes[key] = hashValue(value);
  }

  const workingTargets: Record<string, FlatTranslations> = {};
  const keysToTranslatePerLocale: Record<string, FlatTranslations> = {};
  // workingTargets starts from the existing targets' values for keys the source still
  // has, so a value there does not say it was translated this run. Delivery is tracked on its own: the engine produced
  // and processChunk accepted this key for this locale.
  const delivered: Record<string, Set<string>> = {};

  for (const locale of to) {
    const existingFlat = existing[locale] ?? {};
    workingTargets[locale] = Object.fromEntries(
      Object.entries(existingFlat).filter(([key]) => Object.hasOwn(sourceFlat, key)),
    );
    delivered[locale] = new Set();

    const toTranslate: FlatTranslations = {};
    for (const [key, value] of Object.entries(sourceFlat)) {
      if (!force) {
        // A blank target is a placeholder (i18next-parser writes one per new key), not a translation.
        const existsInTarget = key in existingFlat && !isUntranslated(value, existingFlat[key]);
        const previousHash = hashStore[key];
        const sourceChanged = previousHash !== undefined && previousHash !== currentSourceHashes[key];
        if (existsInTarget && !sourceChanged) continue;
      }
      // There is nothing in a blank value to translate, and an engine's empty answer
      // is discarded: queuing it would re-send the key on every run.
      if (value.trim() === '') workingTargets[locale][key] = value;
      else toTranslate[key] = value;
    }
    if (Object.keys(toTranslate).length > 0) {
      keysToTranslatePerLocale[locale] = toTranslate;
    }
  }

  const allKeysNeeded = new Set<string>();
  for (const keys of Object.values(keysToTranslatePerLocale)) {
    for (const key in keys) allKeysNeeded.add(key);
  }

  if (allKeysNeeded.size === 0) {
    log('info', `[${namespace}]${dryRun ? ' [dry-run]' : ''} Nothing to translate. All locales up to date.`);
    stats.elapsedMs = Date.now() - startTime;
    return {
      translations: workingTargets,
      updatedHashStore: buildUpdatedHashStore(hashStore, currentSourceHashes),
      updatedTranslationMemory: translationMemory,
      stats,
      log,
    };
  }

  const activeLocales = Object.keys(keysToTranslatePerLocale);
  log(
    'info',
    `[${namespace}]${dryRun ? ' [dry-run]' : ''} Translating ${allKeysNeeded.size} key(s) → ${activeLocales.join(', ')}`,
  );

  const tmCache: Record<string, Record<string, string>> = {};
  // Computed once, for the keys that are looked up; the write-back reuses them.
  const memoryKeys: Record<string, string> = {};
  const keysNeedingTranslation: FlatTranslations = {};

  for (const key of allKeysNeeded) {
    const hash = memoryKey(sourceFlat[key]);
    memoryKeys[key] = hash;
    // A locale is active because of some key; that does not make every key its own.
    const localesNeeding = activeLocales.filter((locale) => key in keysToTranslatePerLocale[locale]);
    // --force asks for fresh translations; what memory holds is replaced, not served.
    const cached = force ? null : lookupTranslationMemory(translationMemory, hash, localesNeeding);

    if (cached) tmCache[key] = cached;
    // a partial hit still leaves the uncovered locales to the engine
    if (localesNeeding.some((locale) => !cached?.[locale])) {
      keysNeedingTranslation[key] = sourceFlat[key];
    }
  }

  for (const [key, cached] of Object.entries(tmCache)) {
    for (const locale of Object.keys(cached)) {
      workingTargets[locale][key] = cached[locale];
      stats.keysTranslated++;
      // This locale's need for the key is met. Dropping it here keeps the locale out
      // of the group the key is sent to, and out of the TM rewrite below.
      delete keysToTranslatePerLocale[locale][key];
    }
  }

  if (Object.keys(keysNeedingTranslation).length === 0) {
    log('info', `[${namespace}] All ${allKeysNeeded.size} key(s) served from translation memory.`);
    stats.elapsedMs = Date.now() - startTime;
    return {
      translations: workingTargets,
      updatedHashStore: buildUpdatedHashStore(hashStore, currentSourceHashes),
      updatedTranslationMemory: translationMemory,
      stats,
      log,
    };
  }

  // Each key goes only to the locales that still need it. Keys with the same set of
  // locales share chunks, so a key one locale lacks is not paid for in every other.
  const groups = new Map<string, { locales: string[]; keys: FlatTranslations }>();
  for (const [key, value] of Object.entries(keysNeedingTranslation)) {
    const locales = activeLocales.filter((locale) => key in keysToTranslatePerLocale[locale]);
    const id = locales.join(',');
    const group = groups.get(id) ?? { locales, keys: {} };
    group.keys[key] = value;
    groups.set(id, group);
  }
  const chunks = [...groups.values()].flatMap(({ locales, keys }) =>
    chunkTranslations(keys, config.splitToken, locales.length).map((chunk) => ({ chunk, locales })),
  );
  log(
    'debug',
    `[${namespace}] ${chunks.length} chunk(s) over ${groups.size} locale group(s) = ${dryRun ? '0 (dry-run)' : chunks.length} request(s)`,
  );

  if (!dryRun) {
    const engine = await createEngine(config, opts.engine);
    const pool = new ConcurrencyPool(config.concurrency);

    // Wire the rate-limit signal so 429 responses from any engine feed back into AIMD.
    // Note: onSuccess fires once per chunk (not per request). A 429 collapses the window
    // immediately via setRateLimitSignal; recovery ramps up one step per 10 completed chunks.
    engine.setRateLimitSignal?.(() => pool.onRateLimited());
    engine.setLogger?.(log);

    // A cut-off response is billed in full and then sent again as two. One note per run,
    // not per chunk: the cost is the same fact however many chunks it happened to.
    let splitReported = false;
    const onSplit = (): void => {
      if (splitReported) return;
      splitReported = true;
      const w = `[${namespace}] Some responses were cut off at the engine's output limit and re-sent in halves. The cut-off ones were still billed; a lower splitToken avoids paying for them.`;
      log('warn', w);
    };

    const tasks = chunks.map(({ chunk, locales }, i) => async () => {
      try {
        await processChunk({
          chunk,
          i,
          total: chunks.length,
          engine,
          locales,
          delivered,
          onSplit,
          from,
          sourceFlat,
          namespace,
          workingTargets,
          config,
          stats,
          log,
          glossaryModel,
        });
      } catch (err) {
        // Re-throw LoquiError as-is to preserve its code (e.g. AUTH, RATE_LIMIT)
        // through the AggregateError wrapper so it appears in logs with its original code.
        if (err instanceof LoquiError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Chunk ${i + 1}/${chunks.length} failed: ${msg}`, {
          cause: err,
        });
      }
    });

    try {
      await pool.run(tasks);
    } catch (err) {
      if (!(err instanceof AggregateError)) throw err;
      // Every chunk that did succeed was paid for. Record the failure and carry the
      // partial result out: the caller writes it, and the hash store below records
      // only what landed, so the next run retries exactly the gap.
      for (const e of err.errors) {
        const msg = `[${namespace}] ${(e as Error).message}`;
        log('warn', msg);
      }
      stats.failedChunks = err.errors.length;
      failure = collapseChunkFailure(err, chunks.length, namespace);
    }

    for (const locale of to) {
      for (const key of delivered[locale]) {
        // Only what the engine delivered this run. A locale's untouched existing
        // value is not a translation of this source hash and must not be recorded
        // as one; entries merge across runs, so a partial record still accumulates.
        updateTranslationMemory(translationMemory, memoryKeys[key], { [locale]: workingTargets[locale][key] });
      }
    }
  }

  // A key counts as done once no locale still has it outstanding. Recording a hash for
  // a key a failed chunk never delivered would make the next run skip it forever, and
  // an existing value cannot stand in for delivery: for a changed key it is the stale one.
  const landedHashes: HashStore = {};
  for (const [key, hash] of Object.entries(currentSourceHashes)) {
    const outstanding = to.some((locale) => {
      const needed = keysToTranslatePerLocale[locale];
      return needed !== undefined && key in needed && !delivered[locale].has(key);
    });
    if (!outstanding) landedHashes[key] = hash;
  }
  // landedHashes is only what this run delivered; the prune has to be measured against
  // the whole current source, or a key that failed here would be dropped and come back
  // looking brand new.
  const updatedHashStore = buildUpdatedHashStore(hashStore, landedHashes, Object.keys(currentSourceHashes));

  stats.elapsedMs = Date.now() - startTime;
  return {
    translations: workingTargets,
    updatedHashStore,
    updatedTranslationMemory: translationMemory,
    stats,
    log,
    failure,
  };
}

/**
 * Every chunk failing the same non-retryable way is that failure, not a chunking
 * problem: a bad API key has to exit AUTH so a caller fixes the key instead of
 * retrying forever. The task wrapper preserves each chunk's code for exactly this.
 * A partial or mixed failure stays CHUNK_FAILED, which is what it is.
 */
function collapseChunkFailure(err: AggregateError, chunkCount: number, namespace: string): LoquiError {
  const { errors } = err;
  const codes = errors.map((e) => (e instanceof LoquiError ? e.code : undefined));
  const [first] = codes;
  // AUTH stops the pool, so fewer errors than chunks is expected there.
  const everyChunk = errors.length === chunkCount || first === 'AUTH';
  if (everyChunk && first !== undefined && codes.every((code) => code === first)) {
    return errors[0] as LoquiError;
  }
  // What happened to the output is the caller's to say: only it knows whether anything was written.
  return new LoquiError('CHUNK_FAILED', `${errors.length} chunk(s) failed for [${namespace}].`, { cause: err });
}
