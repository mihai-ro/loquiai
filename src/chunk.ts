import { STRUCTURED_OUTPUT_MAX_PROPS } from './engines/utils.js';
import { LoquiError } from './errors.js';
import { buildGlossaryPromptBlock, findTermsInText, maskTerms } from './glossary.js';
import { IcuMaskError, maskPlaceholders, restorePlaceholders } from './placeholder.js';
import type {
  EngineAdapter,
  FlatTranslations,
  GlossaryModel,
  LoquiConfig,
  RunStats,
  TranslateChunkRequest,
  TranslationChunk,
  TranslationResult,
} from './types.js';
import type { LogFn } from './utils/logger.js';

interface ProcessChunkOptions {
  chunk: TranslationChunk;
  i: number;
  total: number;
  engine: EngineAdapter;
  /** the locales this chunk is for: every key in it is wanted by every one of them. */
  locales: string[];
  /** per locale, the keys written this run; processChunk adds to it. */
  delivered: Record<string, Set<string>>;
  /** called whenever a cut-off chunk is split, so the run can say so once. */
  onSplit: () => void;
  from: string;
  sourceFlat: FlatTranslations;
  namespace: string;
  workingTargets: Record<string, FlatTranslations>;
  config: LoquiConfig;
  stats: RunStats;
  /** the run's log: a `warn` through it is also recorded in `stats.warnings`. */
  log: LogFn;
  /** narrows this run's concurrency pool; handed to the engine with each request. */
  onRateLimited: () => void;
  glossaryModel?: GlossaryModel;
}

// Translations more than 4× the source length are almost certainly hallucinations.
const MAX_EXPANSION_RATIO = 4;

export async function processChunk(opts: ProcessChunkOptions): Promise<void> {
  const {
    chunk,
    i,
    total,
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
    onRateLimited,
    glossaryModel,
  } = opts;

  const noTranslate = glossaryModel?.noTranslate ?? [];
  const { maskedChunk, maskMaps, skipped } = maskChunk(chunk, config.placeholderPatterns, noTranslate);
  for (const [key, reason] of Object.entries(skipped)) {
    const w = `[${namespace}] Key "${key}" was not sent for translation: ${reason}`;
    log('warn', w);
  }
  if (Object.keys(maskedChunk.keys).length === 0) {
    log('debug', `[${namespace}] Chunk ${i + 1}/${total} had nothing left to send`);
    return;
  }

  const chunkText = Object.values(chunk.keys).join('\n');
  const glossaryBlock = glossaryModel ? buildGlossaryPromptBlock(glossaryModel.terms, chunkText, locales) : '';

  const writeResults = (results: Record<string, TranslationResult>, sent: TranslationChunk): void => {
    for (const locale of locales) {
      const localeResult = results[locale];
      if (!localeResult) continue;

      const restored = restoreChunk(localeResult.keys, maskMaps);

      for (const [key, value] of Object.entries(restored)) {
        // A custom engine can answer with more than it was sent. Only what was asked for
        // may land: anything else would overwrite a value this run never meant to touch.
        if (!Object.hasOwn(sent.keys, key)) continue;

        if (!value.trim()) {
          const w = `[${namespace}→${locale}] Empty translation for key: "${key}"`;
          log('warn', w);
          continue;
        }

        // Re-use the mask map already computed in maskChunk — avoids re-running all placeholder regexes.
        const originalTokens = Object.values(maskMaps[key] ?? {});
        const missing = [...new Set(originalTokens)].filter((t) => !value.includes(t));
        if (missing.length > 0) {
          const w = `[${namespace}→${locale}] Key "${key}" is missing placeholders: ${missing.join(', ')} — skipped, will retry on next run`;
          log('warn', w);
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
            log('warn', w);
            continue;
          }
        }

        const sourceValue = sourceFlat[key] ?? '';

        // Untranslated detection: value identical to source suggests the model
        // returned the input unchanged. Warn but save — could be a proper noun.
        if (locale !== from && sourceValue.trim() !== '' && value.trim() === sourceValue.trim()) {
          const w = `[${namespace}→${locale}] Key "${key}" appears untranslated (identical to source)`;
          log('warn', w);
        }

        // Length explosion: ratio > 4× source is almost certainly a hallucination.
        if (sourceValue.length > 0 && value.length > sourceValue.length * MAX_EXPANSION_RATIO) {
          const ratio = Math.round(value.length / sourceValue.length);
          const w = `[${namespace}→${locale}] Key "${key}" translation is ${ratio}× source length — possible hallucination`;
          log('warn', w);
        }

        workingTargets[locale][key] = value;
        delivered[locale].add(key);
        stats.keysTranslated++;
      }
    }
  };

  // A response cut off at the output limit is not a dead end: the same keys fit once
  // the chunk is halved. A single key that still does not fit is the caller's to fix.
  const translateKeys = async (keys: string[]): Promise<void> => {
    const sent: TranslationChunk = { keys: Object.fromEntries(keys.map((key) => [key, maskedChunk.keys[key]])) };
    let results: Record<string, TranslationResult>;
    try {
      const request: TranslateChunkRequest = {
        chunk: sent,
        targetLocales: locales,
        sourceLocale: from,
        namespace,
        glossaryBlock,
        log,
        onRateLimited,
      };
      results = await engine.translateChunk(request);
      stats.apiRequests++;

      if (config.review && engine.reviewChunk) {
        results = await engine.reviewChunk({ ...request, initial: results });
        stats.apiRequests++;
      }
    } catch (err) {
      if (!(err instanceof LoquiError && err.code === 'TRUNCATED') || keys.length < 2) throw err;

      onSplit();
      const middle = Math.ceil(keys.length / 2);
      log(
        'debug',
        `[${namespace}] Chunk ${i + 1}/${total} was cut off at ${keys.length} key(s) — retrying as ${middle} + ${keys.length - middle}`,
      );
      // Both halves run even if the first fails: what the second delivers is paid for.
      const failures: unknown[] = [];
      for (const half of [keys.slice(0, middle), keys.slice(middle)]) {
        try {
          await translateKeys(half);
        } catch (halfErr) {
          failures.push(halfErr);
        }
      }
      // Only the first is thrown, and the pool reports that one; the rest would vanish.
      for (const other of failures.slice(1)) {
        const w = `[${namespace}] Chunk ${i + 1}/${total} also failed: ${other instanceof Error ? other.message : String(other)}`;
        log('warn', w);
      }
      if (failures.length > 0) throw failures[0];
      return;
    }
    writeResults(results, sent);
  };

  await translateKeys(Object.keys(maskedChunk.keys));

  log('debug', `[${namespace}] Chunk ${i + 1}/${total} done`);
}

function maskChunk(
  chunk: TranslationChunk,
  customPatterns?: string[],
  noTranslate: string[] = [],
): {
  maskedChunk: TranslationChunk;
  maskMaps: Record<string, Record<string, string>>;
  /** keys left out of the chunk, with why. One malformed value must not fail the keys beside it. */
  skipped: Record<string, string>;
} {
  const maskedKeys: FlatTranslations = {};
  const maskMaps: Record<string, Record<string, string>> = {};
  const skipped: Record<string, string> = {};
  for (const [key, value] of Object.entries(chunk.keys)) {
    // 1) mask do-not-translate terms first (T-prefix range: ⟦T0⟧, ⟦T1⟧…)
    const termMask = maskTerms(value, noTranslate, 0);
    // 2) mask placeholders on the already-term-masked string (⟦0⟧, ⟦1⟧…)
    try {
      const { masked, map } = maskPlaceholders(termMask.masked, customPatterns);
      maskedKeys[key] = masked;
      maskMaps[key] = { ...termMask.map, ...map };
    } catch (err) {
      // Only the value's own malformation is skippable; a bad config pattern fails every key alike.
      if (!(err instanceof IcuMaskError)) throw err;
      skipped[key] = err.message;
    }
  }
  return { maskedChunk: { keys: maskedKeys }, maskMaps, skipped };
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
