import fs from 'node:fs';
import path from 'node:path';
import { type FailedRunResult, LoquiError } from './errors.js';
import { buildGlossaryModel } from './glossary.js';
import { localeStore, mergeOwnedHashes, readSidecar, type Sidecar, saveSidecar } from './hasher.js';
import type { TranslateOptions } from './lib.js';
import {
  assertEveryLocaleMapped,
  loadExisting,
  loadSource,
  resolveConfig,
  resolveOutputPaths,
  resolveTargets,
  sidecarPath,
} from './project.js';
import { runObject } from './translate-object.js';
import { loadTranslationMemory, saveTranslationMemory } from './translation-memory.js';
import type { LocaleHashes, ObjectRun, TranslateResult, TranslationMemory } from './types.js';
import { writeFileAtomic } from './utils/json.js';

export async function translateFile(options: TranslateOptions): Promise<TranslateResult> {
  // A v2 JavaScript caller that still passes one of these would otherwise start a paid
  // translation it meant as a read-only check. Refused before anything is read or created.
  for (const [flag, replacement] of [
    ['diff', 'diff()'],
    ['validate', 'validate()'],
  ] as const) {
    if (Reflect.get(options, flag) !== undefined) {
      throw new LoquiError(
        'INVALID_CONFIG',
        `translate() no longer takes '${flag}'. Call ${replacement} instead: it reads the files and translates nothing.`,
      );
    }
  }

  const config = resolveConfig(options.configPath, options.config);

  const from = options.from ?? config.from;
  if (!from) throw new LoquiError('INVALID_CONFIG', "'from' (source locale) is required. Set it in options or config.");

  const to = resolveTargets(options.to, config);
  const { inputPath, source, sourceFlat, inlineGlossaryTerms } = loadSource(options.input, config);

  const namespace =
    options.namespace ?? (inputPath ? path.basename(inputPath, path.extname(inputPath)) : 'translation');

  const outputPaths = resolveOutputPaths(options.output, to);
  if (outputPaths) assertEveryLocaleMapped(outputPaths, to);
  // existing translations, for missing-key detection
  const existing = loadExisting(outputPaths, to);

  // Read only when the run uses it: a corrupt sidecar it never consults must not fail it.
  const useIncremental = options.incremental || Boolean(options.hashFile);
  const hashFilePath = sidecarPath(inputPath, options.hashFile, 'hash');
  const sidecar: Sidecar = hashFilePath && useIncremental ? readSidecar(hashFilePath, to) : { locales: {}, owners: {} };
  const hashStore: LocaleHashes = sidecar.locales;
  // Inputs sharing one sidecar are told apart by their path from it; raw JSON has only its namespace.
  const ownerId =
    hashFilePath && inputPath
      ? path.relative(path.dirname(hashFilePath), inputPath).split(path.sep).join('/')
      : namespace;

  // load translation memory if enabled
  const useTranslationMemory = options.translationMemory || Boolean(options.translationMemoryFile);
  const tmFilePath = sidecarPath(inputPath, options.translationMemoryFile, 'tm');
  const loadedMemory = useTranslationMemory && tmFilePath ? loadTranslationMemory(tmFilePath) : undefined;
  const translationMemory: TranslationMemory = loadedMemory?.memory ?? {};

  const glossaryModel = buildGlossaryModel(
    config.glossary,
    inlineGlossaryTerms,
    to,
    inputPath ? path.dirname(inputPath) : process.cwd(),
  );

  /** Writes what a run produced, unless it is a dry run or nothing landed to write. */
  const persist = (
    run: Pick<ObjectRun, 'locales' | 'hashes' | 'memory'>,
    nothingLanded: boolean,
  ): Record<string, string> => {
    const written: Record<string, string> = {};
    if (options.dryRun || nothingLanded) return written;

    for (const [locale, dest] of Object.entries(outputPaths ?? {})) {
      const doc = run.locales[locale];
      if (doc === undefined) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeFileAtomic(dest, `${JSON.stringify(doc, null, 2)}\n`);
      written[locale] = dest;
    }
    // A locale's hashes move only with its file: nothing written for it means it still
    // owes whatever it owed, whichever other locales this run delivered.
    if (useIncremental && hashFilePath && Object.keys(written).length > 0) {
      saveSidecar(hashFilePath, mergeRun(sidecar, ownerId, Object.keys(sourceFlat), Object.keys(written), run.hashes));
    }
    if (useTranslationMemory && tmFilePath) saveTranslationMemory(tmFilePath, run.memory);
    return written;
  };

  let run: ObjectRun;
  try {
    run = await runObject(
      source,
      {
        from,
        to,
        namespace,
        config,
        existing,
        hashes: useIncremental ? hashStore : undefined,
        memory: useTranslationMemory ? translationMemory : undefined,
        glossary: glossaryModel ?? undefined,
        force: options.force,
        dryRun: options.dryRun,
        engine: options.engine,
        logger: options.logger,
      },
      loadedMemory?.warnings,
    );
  } catch (err) {
    // Whatever landed is written before the failure is raised, so a partial run still
    // leaves its output on disk and the next run resumes from the gap. A run that
    // failed without translating anything has nothing to persist: writing anyway would
    // create locale files holding only the source's non-string values, and would prune
    // the hash sidecar on the strength of a run that never happened.
    if (!(err instanceof LoquiError) || !err.result) throw err;
    const { result } = err;
    const landed = result.stats.keysTranslated > 0;
    const written = persist(
      { locales: result.locales, hashes: result.hashes ?? {}, memory: result.memory ?? {} },
      !landed,
    );
    throw completeFailure(err, { ...result, written }, landed, outputPaths !== null);
  }

  const written = persist(run, false);
  return { locales: run.locales, stats: run.stats, removed: run.removed, written };
}

/**
 * The core cannot tell whether its output was written, so the message is finished here.
 * An engine error that failed every chunk keeps its own message: a caller acts on it.
 */
function completeFailure(
  failure: LoquiError,
  result: FailedRunResult,
  landed: boolean,
  wroteOutput: boolean,
): LoquiError {
  if (failure.code !== 'CHUNK_FAILED') {
    return new LoquiError(failure.code, failure.message, { cause: failure.cause, result });
  }
  let outcome = 'Nothing succeeded, so there is nothing to write.';
  if (landed) {
    outcome = wroteOutput
      ? 'Output for the chunks that succeeded was written to disk; re-run to retry the rest.'
      : 'No output path is set, so nothing was saved. Set one to keep partial results; API callers can read error.result.';
  }
  return new LoquiError('CHUNK_FAILED', `${failure.message} ${outcome}`, { cause: failure.cause, result });
}

/**
 * The sidecar after this input delivered `delivered`: their hashes merged in per owner, and
 * this input's key list moved to its current source. A key it dropped stays on the list
 * while a locale it did not deliver still holds it, so that locale's next run prunes it.
 */
function mergeRun(
  sidecar: Sidecar,
  ownerId: string,
  sourceKeys: string[],
  delivered: string[],
  runHashes: LocaleHashes,
): Sidecar {
  const ownedBefore = new Set(Object.hasOwn(sidecar.owners, ownerId) ? sidecar.owners[ownerId] : []);
  const ownedByOthers = new Set(Object.entries(sidecar.owners).flatMap(([id, keys]) => (id === ownerId ? [] : keys)));
  const locales: LocaleHashes = { ...sidecar.locales };
  for (const locale of delivered) {
    if (!Object.hasOwn(runHashes, locale)) continue;
    locales[locale] = mergeOwnedHashes(
      localeStore(sidecar.locales, locale),
      ownedBefore,
      ownedByOthers,
      runHashes[locale],
    );
  }
  const held = new Set(Object.values(locales).flatMap((store) => Object.keys(store)));
  const owned = new Set([...sourceKeys, ...[...ownedBefore].filter((key) => held.has(key))]);
  return { locales, owners: { ...sidecar.owners, [ownerId]: [...owned] } };
}
