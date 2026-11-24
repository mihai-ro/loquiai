import { chunkTranslations } from './chunk.js';
import { hashValue, localeStore } from './hasher.js';
import { lookupTranslationMemory, memoryKey } from './translation-memory.js';
import type {
  FlatTranslations,
  HashStore,
  LocaleHashes,
  LoquiConfig,
  RunLog,
  RunStats,
  TranslationChunk,
  TranslationMemory,
} from './types.js';
import { isUntranslated } from './untranslated.js';

/** What planning needs of a run: the source, what each locale already has, and what memory knows. */
export interface PlanOptions {
  sourceFlat: FlatTranslations;
  to: string[];
  namespace: string;
  config: LoquiConfig;
  existing?: Record<string, FlatTranslations>;
  hashStore?: LocaleHashes;
  force?: boolean;
  dryRun?: boolean;
  /** per locale, keys the caller has stopped retrying: not sent, and warned about. */
  capped?: Record<string, ReadonlySet<string>>;
}

export interface PlannedChunk {
  chunk: TranslationChunk;
  /** the locales this chunk is for: every key in it is wanted by every one of them. */
  locales: string[];
}

/** The state planning hands to execution: what to send, and the books to settle afterwards. */
export interface RunPlan {
  /** each locale's document so far: its existing values, plus what memory served. */
  workingTargets: Record<string, FlatTranslations>;
  /** per locale, the keys written this run; execution adds to it. */
  delivered: Record<string, Set<string>>;
  /** whether a locale still owes a key it needed: its hash is recorded only when it owes none. */
  outstanding: (locale: string, key: string) => boolean;
  currentSourceHashes: HashStore;
  /** the memory key of each key that was looked up. */
  memoryKeys: Record<string, string>;
  /** empty when nothing has to be sent. */
  chunks: PlannedChunk[];
}

/**
 * Decides what a run sends: which keys each locale needs, what translation memory already
 * answers, and how the rest is grouped by locale set and cut into chunks. Sends nothing.
 */
export function planRun(
  opts: PlanOptions,
  translationMemory: TranslationMemory,
  log: RunLog,
  stats: RunStats,
): RunPlan {
  const {
    sourceFlat,
    to,
    namespace,
    config,
    existing = {},
    hashStore = {},
    force = false,
    dryRun = false,
    capped = {},
  } = opts;

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
  // Capped keys the locale still needs: left unsent, and still owed, so no hash is recorded
  // for them and a stale value that is there is not taken for a current one.
  const withheld: Record<string, Set<string>> = {};

  for (const locale of to) {
    const existingFlat = existing[locale] ?? {};
    workingTargets[locale] = Object.fromEntries(
      Object.entries(existingFlat).filter(([key]) => Object.hasOwn(sourceFlat, key)),
    );
    delivered[locale] = new Set();
    withheld[locale] = new Set();

    const localeHashes = localeStore(hashStore, locale) ?? {};
    const toTranslate: FlatTranslations = {};
    for (const [key, value] of Object.entries(sourceFlat)) {
      if (!force) {
        // A blank target is a placeholder (i18next-parser writes one per new key), not a translation.
        const existsInTarget = Object.hasOwn(existingFlat, key) && !isUntranslated(value, existingFlat[key]);
        const previousHash = Object.hasOwn(localeHashes, key) ? localeHashes[key] : undefined;
        const sourceChanged = previousHash !== undefined && previousHash !== currentSourceHashes[key];
        if (existsInTarget && !sourceChanged) continue;
      }
      // There is nothing in a blank value to translate, and an engine's empty answer
      // is discarded: queuing it would re-send the key on every run.
      if (value.trim() === '') workingTargets[locale][key] = value;
      else if (Object.hasOwn(capped, locale) && capped[locale].has(key)) {
        withheld[locale].add(key);
        log.warning({
          code: 'RETRY_CAP',
          message: `[${namespace}→${locale}] Key "${key}" was turned down on every earlier run and is not sent again until its source changes. Run again with force to try it anyway.`,
          locale,
          key,
        });
      } else toTranslate[key] = value;
    }
    if (Object.keys(toTranslate).length > 0) {
      keysToTranslatePerLocale[locale] = toTranslate;
    }
  }

  // A locale owes a key it needed and the engine has not delivered. Its hash is recorded
  // only when it owes nothing: recording one for a key a failed chunk never delivered
  // would make the next run skip it forever, and an existing value cannot stand in for
  // delivery, since for a changed key it is the stale one.
  const outstanding = (locale: string, key: string): boolean => {
    const needed = keysToTranslatePerLocale[locale];
    return (
      (needed !== undefined && Object.hasOwn(needed, key) && !delivered[locale].has(key)) || withheld[locale].has(key)
    );
  };

  // Computed once, for the keys that are looked up; the write-back reuses them.
  const memoryKeys: Record<string, string> = {};
  const finish = (chunks: PlannedChunk[]): RunPlan => ({
    workingTargets,
    delivered,
    outstanding,
    currentSourceHashes,
    memoryKeys,
    chunks,
  });

  const allKeysNeeded = new Set<string>();
  for (const keys of Object.values(keysToTranslatePerLocale)) {
    for (const key in keys) allKeysNeeded.add(key);
  }

  if (allKeysNeeded.size === 0) {
    log('info', `[${namespace}]${dryRun ? ' [dry-run]' : ''} Nothing to translate. All locales up to date.`);
    return finish([]);
  }

  const activeLocales = Object.keys(keysToTranslatePerLocale);
  log(
    'info',
    `[${namespace}]${dryRun ? ' [dry-run]' : ''} Translating ${allKeysNeeded.size} key(s) → ${activeLocales.join(', ')}`,
  );

  const tmCache: Record<string, Record<string, string>> = {};
  const keysNeedingTranslation: FlatTranslations = {};

  for (const key of allKeysNeeded) {
    const hash = memoryKey(sourceFlat[key], key);
    memoryKeys[key] = hash;
    // A locale is active because of some key; that does not make every key its own.
    const localesNeeding = activeLocales.filter((locale) => Object.hasOwn(keysToTranslatePerLocale[locale], key));
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
    return finish([]);
  }

  // Each key goes only to the locales that still need it. Keys with the same set of
  // locales share chunks, so a key one locale lacks is not paid for in every other.
  const groups = new Map<string, { locales: string[]; keys: FlatTranslations }>();
  for (const [key, value] of Object.entries(keysNeedingTranslation)) {
    const locales = activeLocales.filter((locale) => Object.hasOwn(keysToTranslatePerLocale[locale], key));
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

  return finish(chunks);
}
