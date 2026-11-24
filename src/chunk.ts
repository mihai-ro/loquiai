import { acceptAnswer } from './accept.js';
import { STRUCTURED_OUTPUT_MAX_PROPS } from './engines/utils.js';
import { LoquiError } from './errors.js';
import { buildGlossaryPromptBlock, maskTerms } from './glossary.js';
import { IcuMaskError, maskPlaceholders } from './placeholder.js';
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
  /** per locale, the keys the run turned down (a broken placeholder, a lost glossary term, a key it could not send); processChunk adds to it. */
  rejected: Record<string, Set<string>>;
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

export async function processChunk(opts: ProcessChunkOptions): Promise<void> {
  const {
    chunk,
    i,
    total,
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
    onRateLimited,
    glossaryModel,
  } = opts;

  const noTranslate = glossaryModel?.noTranslate ?? [];
  const { maskedChunk, maskMaps } = maskChunk(chunk, config.placeholderPatterns, noTranslate, (key, reason) => {
    for (const locale of locales) rejected[locale].add(key);
    log.warning({
      code: 'NOT_SENT',
      message: `[${namespace}] Key "${key}" was not sent for translation: ${reason}`,
      key,
    });
  });
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

        const outcome = acceptAnswer({
          key,
          locale,
          from,
          namespace,
          sent: sent.keys[key],
          answer: masked,
          map: maskMaps[key] ?? {},
          source: sourceFlat[key] ?? '',
          glossary: glossaryModel,
        });
        for (const warning of outcome.warnings) log.warning(warning);
        if (!outcome.accepted) {
          rejected[locale].add(key);
          continue;
        }

        const { value } = outcome;
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
    // Placeholders first (⟦0⟧, ⟦1⟧…), so a term that matches part of one, `{plan}` for the term
    // `Plan`, cannot strip it of its mask. Terms are then masked in what is left (⟦T0⟧, ⟦T1⟧…).
    try {
      const placeholders = maskPlaceholders(value, customPatterns);
      const terms = maskTerms(placeholders.masked, noTranslate, 0);
      maskedKeys[key] = terms.masked;
      // Restore runs in reverse: terms come back first, then the placeholders around them.
      maskMaps[key] = { ...placeholders.map, ...terms.map };
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
