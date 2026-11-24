import { processChunk } from './chunk.js';
import { ConcurrencyPool } from './concurrency-pool.js';
import { createEngine } from './engines/factory.js';
import { LoquiError } from './errors.js';
import { buildUpdatedHashes } from './hasher.js';
import { planRun } from './plan.js';
import { updateTranslationMemory } from './translation-memory.js';
import type {
  EngineAdapter,
  FlatTranslations,
  GlossaryModel,
  LocaleHashes,
  LoquiConfig,
  RunLog,
  RunStats,
  RunWarning,
  TranslationMemory,
} from './types.js';
import type { LogFn } from './utils/logger.js';

export interface TranslateJobOptions {
  sourceFlat: FlatTranslations;
  from: string;
  to: string[];
  namespace: string;
  config: LoquiConfig;
  existing?: Record<string, FlatTranslations>;
  hashStore?: LocaleHashes;
  translationMemory?: TranslationMemory;
  glossaryModel?: GlossaryModel;
  force?: boolean;
  dryRun?: boolean;
  /** per locale, keys the caller has stopped retrying; see `PlanOptions.capped`. */
  capped?: Record<string, ReadonlySet<string>>;
  engine?: EngineAdapter;
  /** where the run's messages go. Required: a site that forgets it would log nowhere. */
  logger: LogFn;
}

export interface TranslateJobResult {
  translations: Record<string, FlatTranslations>;
  updatedHashStore: LocaleHashes;
  updatedTranslationMemory: TranslationMemory;
  /** per locale, the keys the run turned down. */
  rejected: Record<string, string[]>;
  stats: RunStats;
  /**
   * The run's log. A caller that has something to say after the run, such as the file
   * layer's note about pruned keys, says it here so it lands in `stats.warnings` too.
   */
  log: RunLog;
  /**
   * Set when chunks failed. The caller persists what succeeded and then raises this,
   * so a partial run still leaves its output on disk.
   */
  failure?: LoquiError;
}

/**
 * The one writer of `stats.warnings`: a warning is recorded in the run's stats and its
 * message goes to the caller's logger, so the two can never disagree.
 */
function createRunLog(stats: RunStats, logger: LogFn): RunLog {
  // What reaches the plain log is what an engine said: the run's own findings use `warning`.
  const log: LogFn = (level, message) => {
    if (level === 'warn') stats.warnings.push({ code: 'ENGINE_RESPONSE', message });
    logger(level, message);
  };
  return Object.assign(log, {
    warning(warning: RunWarning): void {
      stats.warnings.push(warning);
      logger('warn', warning.message);
    },
  });
}

export async function translateJson(opts: TranslateJobOptions): Promise<TranslateJobResult> {
  const {
    sourceFlat,
    from,
    to,
    namespace,
    config,
    hashStore = {},
    translationMemory: tmOpt,
    glossaryModel,
    dryRun = false,
  } = opts;

  const stats: RunStats = {
    keysTranslated: 0,
    apiRequests: 0,
    elapsedMs: 0,
    warnings: [],
    failedChunks: 0,
    plan: { requests: 0, keys: {} },
  };
  const log = createRunLog(stats, opts.logger);
  const startTime = Date.now();

  const translationMemory = tmOpt ?? {};
  let failure: LoquiError | undefined;

  const plan = planRun(opts, translationMemory, log, stats);
  const { workingTargets, delivered, outstanding, currentSourceHashes, memoryKeys } = plan;
  const { chunks } = plan;
  stats.plan = plan.summary;
  const rejected: Record<string, Set<string>> = Object.fromEntries(to.map((locale) => [locale, new Set<string>()]));
  const rejectedLists = (): Record<string, string[]> =>
    Object.fromEntries(Object.entries(rejected).map(([locale, keys]) => [locale, [...keys]]));

  if (chunks.length === 0) {
    stats.elapsedMs = Date.now() - startTime;
    return {
      translations: workingTargets,
      updatedHashStore: buildUpdatedHashes(hashStore, to, currentSourceHashes, outstanding),
      updatedTranslationMemory: translationMemory,
      rejected: rejectedLists(),
      stats,
      log,
    };
  }

  if (!dryRun) {
    const engine = await createEngine(config, opts.engine);
    const pool = new ConcurrencyPool(config.concurrency);

    // A cut-off response is billed in full and then sent again as two. One note per run,
    // not per chunk: the cost is the same fact however many chunks it happened to.
    let splitReported = false;
    const onSplit = (): void => {
      if (splitReported) return;
      splitReported = true;
      log.warning({
        code: 'CUT_OFF',
        message: `[${namespace}] Some responses were cut off at the engine's output limit and re-sent in halves. The cut-off ones were still billed; a lower splitToken avoids paying for them.`,
      });
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
          rejected,
          onSplit,
          from,
          sourceFlat,
          namespace,
          workingTargets,
          config,
          stats,
          log,
          // A 429 narrows this run's pool only: the engine may be shared with other runs.
          onRateLimited: () => pool.onRateLimited(),
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
        log.warning({ code: 'CHUNK_FAILED', message: `[${namespace}] ${(e as Error).message}` });
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

  const updatedHashStore = buildUpdatedHashes(hashStore, to, currentSourceHashes, outstanding);

  stats.elapsedMs = Date.now() - startTime;
  return {
    translations: workingTargets,
    updatedHashStore,
    updatedTranslationMemory: translationMemory,
    rejected: rejectedLists(),
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
