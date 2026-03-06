import { FlatTranslations, TranslationChunk, FalarConfig, RunStats, HashStore, EngineAdapter } from './types.js';
import { maskPlaceholders, restorePlaceholders } from './placeholder.js';
import { hashValue, buildUpdatedHashStore } from './hasher.js';
import { createEngine } from './engines/factory.js';
import { logger } from './utils/logger.js';

export interface TranslateJobOptions {
  sourceFlat: FlatTranslations;
  from: string;
  to: string[];
  namespace: string;
  config: FalarConfig;
  /** existing translations per locale — used to skip already-translated keys */
  existing?: Record<string, FlatTranslations>;
  /** if provided, also re-translate keys whose source text changed since last run */
  hashStore?: HashStore;
  force?: boolean;
  dryRun?: boolean;
  engine?: EngineAdapter;
}

export interface TranslateJobResult {
  /** locale → merged flat translations (existing + newly translated) */
  translations: Record<string, FlatTranslations>;
  updatedHashStore: HashStore;
  stats: RunStats;
}

export async function translateJson(opts: TranslateJobOptions): Promise<TranslateJobResult> {
  const { sourceFlat, from, to, namespace, config, existing = {}, hashStore = {}, force = false, dryRun = false } = opts;

  const stats: RunStats = { keysTranslated: 0, apiRequests: 0, elapsedMs: 0, warnings: [] };
  const startTime = Date.now();

  // Hashes are source-derived — compute once for all keys, regardless of what needs translating.
  // This ensures the hash file is always up to date even on "nothing to do" runs.
  const currentSourceHashes: HashStore = {};
  for (const [key, value] of Object.entries(sourceFlat)) {
    currentSourceHashes[key] = hashValue(value);
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
    return { translations: workingTargets, updatedHashStore: buildUpdatedHashStore(hashStore, currentSourceHashes), stats };
  }

  const activeLocales = Object.keys(keysToTranslatePerLocale);
  logger.info(`[${namespace}]${dryRun ? ' [dry-run]' : ''} Translating ${allKeysNeeded.size} key(s) → ${activeLocales.join(', ')}`);

  const unionToTranslate: FlatTranslations = {};
  for (const key of allKeysNeeded) unionToTranslate[key] = sourceFlat[key];

  const chunks = chunkTranslations(unionToTranslate, config.splitToken, activeLocales.length);
  logger.dim(`[${namespace}] ${chunks.length} chunk(s) × ${activeLocales.length} locale(s) = ${dryRun ? '0 (dry-run)' : chunks.length} request(s)`);

  if (!dryRun) {
    const engine = createEngine(config, opts.engine);
    const failures: number[] = [];

    const tasks = chunks.map((chunk, i) => async () => {
      try {
        await processChunk({ chunk, i, total: chunks.length, engine, activeLocales, from, sourceFlat, namespace, workingTargets, config, stats });
      } catch (err) {
        logger.warn(`[${namespace}] Chunk ${i + 1}/${chunks.length} failed: ${(err as Error).message}`);
        failures.push(i);
      }
    });

    await runConcurrent(tasks, config.concurrency);

    if (failures.length > 0) {
      throw new Error(`${failures.length} chunk(s) failed for [${namespace}]. Indices: ${failures.join(', ')}`);
    }
  }

  const updatedHashStore = buildUpdatedHashStore(hashStore, currentSourceHashes);

  stats.elapsedMs = Date.now() - startTime;
  return { translations: workingTargets, updatedHashStore, stats };
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
  config: FalarConfig;
  stats: RunStats;
}

async function processChunk(opts: ProcessChunkOptions): Promise<void> {
  const { chunk, i, total, engine, activeLocales, from, sourceFlat, namespace, workingTargets, config, stats } = opts;

  const { maskedChunk, maskMaps } = maskChunk(chunk, config.placeholderPatterns);
  const results = await engine.translateChunk(maskedChunk, activeLocales, from, namespace);
  stats.apiRequests++;

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

      workingTargets[locale][key] = value;
      stats.keysTranslated++;
    }
  }

  logger.dim(`[${namespace}] Chunk ${i + 1}/${total} done`);
}

function maskChunk(chunk: TranslationChunk, customPatterns?: string[]): {
  maskedChunk: TranslationChunk;
  maskMaps: Record<string, Record<string, string>>;
} {
  const maskedKeys: FlatTranslations = {};
  const maskMaps: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(chunk.keys)) {
    const { masked, map } = maskPlaceholders(value, customPatterns);
    maskedKeys[key] = masked;
    maskMaps[key] = map;
  }
  return { maskedChunk: { keys: maskedKeys }, maskMaps };
}

function restoreChunk(translatedKeys: FlatTranslations, maskMaps: Record<string, Record<string, string>>): FlatTranslations {
  const restored: FlatTranslations = {};
  for (const [key, value] of Object.entries(translatedKeys)) {
    restored[key] = restorePlaceholders(value, maskMaps[key] ?? {});
  }
  return restored;
}

function chunkTranslations(flat: FlatTranslations, splitToken: number, localeCount: number): TranslationChunk[] {
  const chunks: TranslationChunk[] = [];
  let current: FlatTranslations = {};
  let currentTokens = 0;
  let currentSize = 0;

  for (const [key, value] of Object.entries(flat)) {
    const entryTokens = Math.ceil((`"${key}": "${value}",\n`.length / 4) * (1 + localeCount));
    if (currentTokens + entryTokens > splitToken && currentSize > 0) {
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

async function runConcurrent(tasks: (() => Promise<void>)[], concurrency: number): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const task of tasks) {
    const p: Promise<void> = task().finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= concurrency) await Promise.race(executing);
  }
  await Promise.all(executing);
}
