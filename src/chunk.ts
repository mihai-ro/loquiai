import { STRUCTURED_OUTPUT_MAX_PROPS } from './engines/utils.js';
import { LoquiError } from './errors.js';
import { buildGlossaryPromptBlock, findTermsInText, maskTerms } from './glossary.js';
import { IcuMaskError, maskPlaceholders, restorePlaceholders } from './placeholder.js';
import type {
  EngineAdapter,
  FlatTranslations,
  GlossaryModel,
  LoquiConfig,
  RunLog,
  RunStats,
  TranslateChunkRequest,
  TranslationChunk,
  TranslationResult,
} from './types.js';

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
  /** the run's log: what it warns about is also recorded in `stats.warnings`. */
  log: RunLog;
  /** narrows this run's concurrency pool; handed to the engine with each request. */
  onRateLimited: () => void;
  glossaryModel?: GlossaryModel;
}

const SENTINEL = /⟦[^⟦⟧]*⟧/g;

function countSentinels(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [token] of text.matchAll(SENTINEL)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * What is wrong with the sentinels in a model's answer, or null when they match what was sent:
 * every sent one back exactly as often, and no other.
 */
function describePlaceholderFault(sent: string, answer: string, map: Record<string, string>): string | null {
  const sentCounts = countSentinels(sent);
  const answerCounts = countSentinels(answer);
  const original = (token: string): string =>
    Object.hasOwn(map, token) ? restorePlaceholders(map[token], map) : token;
  const list = (tokens: string[]): string => [...new Set(tokens.map(original))].join(', ');

  const missing = [...sentCounts.keys()].filter((token) => !answerCounts.has(token));
  const repeated = [...sentCounts].filter(([token, n]) => answerCounts.has(token) && answerCounts.get(token) !== n);
  const unsent = [...answerCounts.keys()].filter((token) => !sentCounts.has(token));

  const faults: string[] = [];
  if (missing.length > 0) faults.push(`is missing placeholders: ${list(missing)}`);
  if (repeated.length > 0)
    faults.push(`has placeholders a different number of times than sent: ${list(repeated.map(([t]) => t))}`);
  if (unsent.length > 0) faults.push(`has placeholders that were never sent: ${list(unsent)}`);
  return faults.length > 0 ? faults.join('; ') : null;
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
  const { maskedChunk, maskMaps } = maskChunk(chunk, config.placeholderPatterns, noTranslate, (key, reason) =>
    log.warning({
      code: 'NOT_SENT',
      message: `[${namespace}] Key "${key}" was not sent for translation: ${reason}`,
      key,
    }),
  );
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

      for (const [key, masked] of Object.entries(localeResult.keys)) {
        // A custom engine can answer with more than it was sent. Only what was asked for
        // may land: anything else would overwrite a value this run never meant to touch.
        if (!Object.hasOwn(sent.keys, key)) continue;

        const map = maskMaps[key] ?? {};
        const value = restorePlaceholders(masked, map);

        if (!value.trim()) {
          log.warning({
            code: 'EMPTY_TRANSLATION',
            message: `[${namespace}→${locale}] Empty translation for key: "${key}"`,
            locale,
            key,
          });
          continue;
        }

        // Checked on the model's answer, before restore: a sentinel nested inside another
        // (a term or placeholder inside a tag) only exists in the map, never in the restored text.
        // The sentinels that count are the ones actually sent; nested ones ride along with their outer one.
        // Each must come back as often as it went out, and nothing else may look like one. Their
        // order is the translation's to change: `{name}` and `{count}` legitimately swap places.
        const fault = describePlaceholderFault(sent.keys[key], masked, map);
        if (fault) {
          log.warning({
            code: 'PLACEHOLDER_MISMATCH',
            message: `[${namespace}→${locale}] Key "${key}" ${fault} — skipped, will retry on next run`,
            locale,
            key,
          });
          continue;
        }

        // Glossary term-lock: the locked target term must appear in the translation.
        if (glossaryModel) {
          const sourceTerms = findTermsInText(sourceFlat[key] ?? '', Object.keys(glossaryModel.terms));
          const missingTerms = sourceTerms.filter((term) => {
            const perLocale = glossaryModel.terms[term];
            const locked = perLocale && Object.hasOwn(perLocale, locale) ? perLocale[locale] : undefined;
            return locked && !value.toLowerCase().includes(locked.toLowerCase());
          });
          if (missingTerms.length > 0) {
            log.warning({
              code: 'MISSING_GLOSSARY_TERM',
              message: `[${namespace}→${locale}] Key "${key}" missing glossary term(s): ${missingTerms.join(', ')} — skipped, will retry on next run`,
              locale,
              key,
            });
            continue;
          }
        }

        const sourceValue = sourceFlat[key] ?? '';

        // Untranslated detection: value identical to source suggests the model
        // returned the input unchanged. Warn but save — could be a proper noun.
        if (locale !== from && sourceValue.trim() !== '' && value.trim() === sourceValue.trim()) {
          log.warning({
            code: 'UNTRANSLATED',
            message: `[${namespace}→${locale}] Key "${key}" appears untranslated (identical to source)`,
            locale,
            key,
          });
        }

        // Length explosion: ratio > 4× source is almost certainly a hallucination.
        if (sourceValue.length > 0 && value.length > sourceValue.length * MAX_EXPANSION_RATIO) {
          const ratio = Math.round(value.length / sourceValue.length);
          log.warning({
            code: 'LENGTH_RATIO',
            message: `[${namespace}→${locale}] Key "${key}" translation is ${ratio}× source length — possible hallucination`,
            locale,
            key,
          });
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
        log.warning({
          code: 'CHUNK_FAILED',
          message: `[${namespace}] Chunk ${i + 1}/${total} also failed: ${other instanceof Error ? other.message : String(other)}`,
        });
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
  /** called for a key left out of the chunk, with why. One malformed value must not fail the keys beside it. */
  onSkipped: (key: string, reason: string) => void = () => {},
): {
  maskedChunk: TranslationChunk;
  maskMaps: Record<string, Record<string, string>>;
} {
  const maskedKeys: FlatTranslations = {};
  const maskMaps: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(chunk.keys)) {
    // The sentinel characters are loqui's own: a value that holds them cannot be told from a
    // masked one, so it is not sent rather than escaped.
    if (value.includes('⟦') || value.includes('⟧')) {
      onSkipped(key, 'the value contains ⟦ or ⟧, which loqui uses for its own placeholder markers');
      continue;
    }
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
      onSkipped(key, err.message);
    }
  }
  return { maskedChunk: { keys: maskedKeys }, maskMaps };
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
