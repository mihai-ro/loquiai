import { createEngine } from './engines/factory.js';
import { STRUCTURED_OUTPUT_MAX_PROPS } from './engines/utils.js';
import { LoquiError } from './errors.js';
import { buildGlossaryPromptBlock, findTermsInText, maskTerms } from './glossary.js';
import { buildUpdatedHashStore, hashValue } from './hasher.js';
import { maskPlaceholders, restorePlaceholders } from './placeholder.js';
import { lookupTranslationMemory, updateTranslationMemory } from './translation-memory.js';
import type {
  EngineAdapter,
  FlatTranslations,
  GlossaryModel,
  HashStore,
  LoquiConfig,
  RunStats,
  TranslationChunk,
  TranslationMemory,
} from './types.js';
import { logger } from './utils/logger.js';

export interface TranslateJobOptions {
  sourceFlat: FlatTranslations;
  from: string;
  to: string[];
  namespace: string;
  config: LoquiConfig;
  existing?: Record<string, FlatTranslations>;
  hashStore?: HashStore;
  translationMemory?: TranslationMemory;
  translationMemoryPath?: string;
  glossaryModel?: GlossaryModel;
  force?: boolean;
  dryRun?: boolean;
  engine?: EngineAdapter;
}

export interface TranslateJobResult {
  translations: Record<string, FlatTranslations>;
  updatedHashStore: HashStore;
  updatedTranslationMemory: TranslationMemory;
  stats: RunStats;
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
    translationMemoryPath: _translationMemoryPath,
    glossaryModel,
    force = false,
    dryRun = false,
  } = opts;

  const stats: RunStats = {
    keysTranslated: 0,
    apiRequests: 0,
    elapsedMs: 0,
    warnings: [],
  };
  const startTime = Date.now();

  const translationMemory = tmOpt ?? {};

  // Hashes are source-derived — compute once for all keys, regardless of what needs translating.
  // This ensures the hash file is always up to date even on "nothing to do" runs.
  const currentSourceHashes: HashStore = {};
  const sourceHashesForTm: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceFlat)) {
    const hash = hashValue(value);
    currentSourceHashes[key] = hash;
    sourceHashesForTm[key] = hash;
  }

  const workingTargets: Record<string, FlatTranslations> = {};
  const keysToTranslatePerLocale: Record<string, FlatTranslations> = {};

  for (const locale of to) {
    const existingFlat = existing[locale] ?? {};
    workingTargets[locale] = { ...existingFlat };

    if (force) {
      keysToTranslatePerLocale[locale] = { ...sourceFlat };
    } else {
      const toTranslate: FlatTranslations = {};
      for (const key of Object.keys(sourceFlat)) {
        const existsInTarget = key in existingFlat;
        const previousHash = hashStore[key];
        const sourceChanged = previousHash !== undefined && previousHash !== currentSourceHashes[key];
        if (!existsInTarget || sourceChanged) toTranslate[key] = sourceFlat[key];
      }
      if (Object.keys(toTranslate).length > 0) {
        keysToTranslatePerLocale[locale] = toTranslate;
      }
    }
  }

  const allKeysNeeded = new Set<string>();
  for (const keys of Object.values(keysToTranslatePerLocale)) {
    for (const key in keys) allKeysNeeded.add(key);
  }

  if (allKeysNeeded.size === 0) {
    logger.info(`[${namespace}]${dryRun ? ' [dry-run]' : ''} Nothing to translate. All locales up to date.`);
    stats.elapsedMs = Date.now() - startTime;
    return {
      translations: workingTargets,
      updatedHashStore: buildUpdatedHashStore(hashStore, currentSourceHashes),
      updatedTranslationMemory: translationMemory,
      stats,
    };
  }

  const activeLocales = Object.keys(keysToTranslatePerLocale);
  logger.info(
    `[${namespace}]${dryRun ? ' [dry-run]' : ''} Translating ${allKeysNeeded.size} key(s) → ${activeLocales.join(', ')}`,
  );

  const tmCache: Record<string, Record<string, string>> = {};
  const keysNeedingTranslation: FlatTranslations = {};

  for (const key of allKeysNeeded) {
    const hash = sourceHashesForTm[key];
    const cached = lookupTranslationMemory(translationMemory, hash, activeLocales);
    if (cached) {
      tmCache[key] = cached;
    } else {
      keysNeedingTranslation[key] = sourceFlat[key];
    }
  }

  for (const [key, cached] of Object.entries(tmCache)) {
    for (const locale of activeLocales) {
      if (!(locale in workingTargets)) workingTargets[locale] = { ...existing[locale] };
      workingTargets[locale][key] = cached[locale];
      stats.keysTranslated++;
    }
  }

  if (Object.keys(keysNeedingTranslation).length === 0) {
    logger.info(`[${namespace}] All ${allKeysNeeded.size} key(s) served from translation memory.`);
    stats.elapsedMs = Date.now() - startTime;
    return {
      translations: workingTargets,
      updatedHashStore: buildUpdatedHashStore(hashStore, currentSourceHashes),
      updatedTranslationMemory: translationMemory,
      stats,
    };
  }

  const chunks = chunkTranslations(keysNeedingTranslation, config.splitToken, activeLocales.length);
  logger.dim(
    `[${namespace}] ${chunks.length} chunk(s) × ${activeLocales.length} locale(s) = ${dryRun ? '0 (dry-run)' : chunks.length} request(s)`,
  );

  if (!dryRun) {
    const engine = await createEngine(config, opts.engine);
    const pool = new ConcurrencyPool(config.concurrency);

    // Wire the rate-limit signal so 429 responses from any engine feed back into AIMD.
    // Note: onSuccess fires once per chunk (not per request). A 429 collapses the window
    // immediately via setRateLimitSignal; recovery ramps up one step per 10 completed chunks.
    engine.setRateLimitSignal?.(() => pool.onRateLimited());

    const tasks = chunks.map((chunk, i) => async () => {
      try {
        await processChunk({
          chunk,
          i,
          total: chunks.length,
          engine,
          activeLocales,
          from,
          sourceFlat,
          namespace,
          workingTargets,
          config,
          stats,
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
      if (err instanceof AggregateError) {
        for (const e of err.errors) {
          logger.warn(`[${namespace}] ${(e as Error).message}`);
        }
        throw new LoquiError('CHUNK_FAILED', `${err.errors.length} chunk(s) failed for [${namespace}]`, { cause: err });
      }
      throw err;
    }

    for (const chunk of chunks) {
      for (const key of Object.keys(chunk.keys)) {
        const hash = sourceHashesForTm[key];
        if (!hash) continue;
        const translations: Record<string, string> = {};
        for (const locale of activeLocales) {
          const translated = workingTargets[locale]?.[key];
          if (translated) translations[locale] = translated;
        }
        if (Object.keys(translations).length === activeLocales.length) {
          updateTranslationMemory(translationMemory, hash, translations);
        }
      }
    }
  }

  const updatedHashStore = buildUpdatedHashStore(hashStore, currentSourceHashes);

  stats.elapsedMs = Date.now() - startTime;
  return {
    translations: workingTargets,
    updatedHashStore,
    updatedTranslationMemory: translationMemory,
    stats,
  };
}

// AIMD concurrency pool
/**
 * Adaptive concurrency pool (AIMD — Additive Increase / Multiplicative Decrease).
 *
 * - Starts at the configured concurrency.
 * - Increases the active window by 1 after RAMP_AFTER consecutive successes.
 * - Halves the window (floor 1) on any rate-limit signal from the engine.
 *
 * The pool integrates with EngineAdapter.setRateLimitSignal?: engines call the
 * callback when they observe a 429, which feeds directly into onRateLimited().
 */
export class ConcurrencyPool {
  #window: number;
  readonly #maxWindow: number;
  #streak = 0;
  static readonly #RAMP_AFTER = 10;

  constructor(initial: number) {
    this.#window = Math.max(1, initial);
    this.#maxWindow = Math.max(1, initial);
  }

  get current(): number {
    return this.#window;
  }

  onRateLimited(): void {
    this.#window = Math.max(1, Math.ceil(this.#window / 2));
    this.#streak = 0;
  }

  onSuccess(): void {
    this.#streak++;
    if (this.#streak >= ConcurrencyPool.#RAMP_AFTER) {
      this.#window = Math.min(this.#maxWindow, this.#window + 1);
      this.#streak = 0;
    }
  }

  async run(tasks: (() => Promise<void>)[]): Promise<void> {
    const executing = new Set<Promise<void>>();
    const errors: unknown[] = [];

    for (const task of tasks) {
      const p: Promise<void> = (async () => {
        try {
          await task();
          this.onSuccess();
        } catch (err) {
          errors.push(err);
        }
      })().finally(() => {
        executing.delete(p);
      });
      executing.add(p);
      while (executing.size >= this.#window) await Promise.race(executing);
    }
    await Promise.all(executing);

    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} task(s) failed`);
    }
  }
}

// ── internals ────────────────────────────────────────────────────────────────

interface ProcessChunkOptions {
  chunk: TranslationChunk;
  i: number;
  total: number;
  engine: EngineAdapter;
  activeLocales: string[];
  from: string;
  sourceFlat: FlatTranslations;
  namespace: string;
  workingTargets: Record<string, FlatTranslations>;
  config: LoquiConfig;
  stats: RunStats;
  glossaryModel?: GlossaryModel;
}

// Translations more than 4× the source length are almost certainly hallucinations.
const MAX_EXPANSION_RATIO = 4;

async function processChunk(opts: ProcessChunkOptions): Promise<void> {
  const {
    chunk,
    i,
    total,
    engine,
    activeLocales,
    from,
    sourceFlat,
    namespace,
    workingTargets,
    config,
    stats,
    glossaryModel,
  } = opts;

  const noTranslate = glossaryModel?.noTranslate ?? [];
  const { maskedChunk, maskMaps } = maskChunk(chunk, config.placeholderPatterns, noTranslate);

  const chunkText = Object.values(chunk.keys).join('\n');
  const glossaryBlock = glossaryModel ? buildGlossaryPromptBlock(glossaryModel.terms, chunkText, activeLocales) : '';

  let results = await engine.translateChunk(maskedChunk, activeLocales, from, namespace, glossaryBlock);
  stats.apiRequests++;

  if (config.review && engine.reviewChunk) {
    results = await engine.reviewChunk(maskedChunk, results, activeLocales, from, namespace, glossaryBlock);
    stats.apiRequests++;
  }

  for (const locale of activeLocales) {
    const localeResult = results[locale];
    if (!localeResult) continue;

    const restored = restoreChunk(localeResult.keys, maskMaps);

    for (const [key, value] of Object.entries(restored)) {
      if (!value.trim()) {
        const w = `[${namespace}→${locale}] Empty translation for key: "${key}"`;
        logger.warn(w);
        stats.warnings.push(w);
        continue;
      }

      // Re-use the mask map already computed in maskChunk — avoids re-running all placeholder regexes.
      const originalTokens = Object.values(maskMaps[key] ?? {});
      const missing = [...new Set(originalTokens)].filter((t) => !value.includes(t));
      if (missing.length > 0) {
        const w = `[${namespace}→${locale}] Key "${key}" is missing placeholders: ${missing.join(', ')} — skipped, will retry on next run`;
        logger.warn(w);
        stats.warnings.push(w);
        continue;
      }

      // Glossary term-lock: the locked target term must appear in the translation.
      if (glossaryModel) {
        const sourceTerms = findTermsInText(sourceFlat[key] ?? '', Object.keys(glossaryModel.terms));
        const missingTerms = sourceTerms.filter((term) => {
          const locked = glossaryModel.terms[term]?.[locale];
          return locked && !value.toLowerCase().includes(locked.toLowerCase());
        });
        if (missingTerms.length > 0) {
          const w = `[${namespace}→${locale}] Key "${key}" missing glossary term(s): ${missingTerms.join(', ')} — skipped, will retry on next run`;
          logger.warn(w);
          stats.warnings.push(w);
          continue;
        }
      }

      const sourceValue = sourceFlat[key] ?? '';

      // Untranslated detection: value identical to source suggests the model
      // returned the input unchanged. Warn but save — could be a proper noun.
      if (locale !== from && sourceValue.trim() !== '' && value.trim() === sourceValue.trim()) {
        const w = `[${namespace}→${locale}] Key "${key}" appears untranslated (identical to source)`;
        logger.warn(w);
        stats.warnings.push(w);
      }

      // Length explosion: ratio > 4× source is almost certainly a hallucination.
      if (sourceValue.length > 0 && value.length > sourceValue.length * MAX_EXPANSION_RATIO) {
        const ratio = Math.round(value.length / sourceValue.length);
        const w = `[${namespace}→${locale}] Key "${key}" translation is ${ratio}× source length — possible hallucination`;
        logger.warn(w);
        stats.warnings.push(w);
      }

      workingTargets[locale][key] = value;
      stats.keysTranslated++;
    }
  }

  logger.dim(`[${namespace}] Chunk ${i + 1}/${total} done`);
}

function maskChunk(
  chunk: TranslationChunk,
  customPatterns?: string[],
  noTranslate: string[] = [],
): {
  maskedChunk: TranslationChunk;
  maskMaps: Record<string, Record<string, string>>;
} {
  const maskedKeys: FlatTranslations = {};
  const maskMaps: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(chunk.keys)) {
    // 1) mask do-not-translate terms first (T-prefix range: ⟦T0⟧, ⟦T1⟧…)
    const termMask = maskTerms(value, noTranslate, 0);
    // 2) mask placeholders on the already-term-masked string (⟦0⟧, ⟦1⟧…)
    const { masked, map } = maskPlaceholders(termMask.masked, customPatterns);
    maskedKeys[key] = masked;
    maskMaps[key] = { ...termMask.map, ...map };
  }
  return { maskedChunk: { keys: maskedKeys }, maskMaps };
}

function restoreChunk(
  translatedKeys: FlatTranslations,
  maskMaps: Record<string, Record<string, string>>,
): FlatTranslations {
  const restored: FlatTranslations = {};
  for (const [key, value] of Object.entries(translatedKeys)) {
    restored[key] = restorePlaceholders(value, maskMaps[key] ?? {});
  }
  return restored;
}

// Exported for unit testing.
export function chunkTranslations(flat: FlatTranslations, splitToken: number, localeCount: number): TranslationChunk[] {
  // Cap keys per chunk at floor(STRUCTURED_OUTPUT_MAX_PROPS / localeCount) so that
  // locales × keys ≤ STRUCTURED_OUTPUT_MAX_PROPS in every chunk, keeping OpenAI
  // json_schema and Anthropic tool_use active. Gemini's limit is 50 (harder cap)
  // but its responseMimeType:'application/json' fallback only enforces JSON syntax —
  // not schema shape; missing/extra keys are possible. extractTranslations handles
  // that gracefully via per-key warnings and empty-string defaults.
  const maxKeysPerChunk =
    localeCount > 0 ? Math.max(1, Math.floor(STRUCTURED_OUTPUT_MAX_PROPS / localeCount)) : STRUCTURED_OUTPUT_MAX_PROPS;
  const chunks: TranslationChunk[] = [];
  let current: FlatTranslations = {};
  let currentTokens = 0;
  let currentSize = 0;

  for (const [key, value] of Object.entries(flat)) {
    const entryTokens = Math.ceil((`"${key}": "${value}",\n`.length / 4) * (1 + localeCount));
    if ((currentTokens + entryTokens > splitToken || currentSize >= maxKeysPerChunk) && currentSize > 0) {
      chunks.push({ keys: current });
      current = {};
      currentTokens = 0;
      currentSize = 0;
    }
    current[key] = value;
    currentTokens += entryTokens;
    currentSize++;
  }

  if (currentSize > 0) chunks.push({ keys: current });
  return chunks;
}
