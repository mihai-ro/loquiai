import fs from 'node:fs';
import path from 'node:path';
import { type FailedRunResult, LoquiError } from './errors.js';
import { buildGlossaryModel } from './glossary.js';
import {
  type Attempt,
  type Attempts,
  cappedKeys,
  hashValue,
  localeStore,
  mergeOwnedHashes,
  ownAttempts,
  ownerId,
  readSidecar,
  type Sidecar,
  saveSidecar,
} from './hasher.js';
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
import { translateObject } from './translate-object.js';
import { loadTranslationMemory, memoryKey, pruneMemory, saveTranslationMemory } from './translation-memory.js';
import type { LocaleHashes, ObjectRun, TranslateResult, TranslationMemory } from './types.js';
import { setOwn, writeFileAtomic } from './utils/json.js';

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

  const namespace = options.namespace ?? path.basename(inputPath, path.extname(inputPath));

  const outputPaths = resolveOutputPaths(options.output, to);
  if (outputPaths) assertEveryLocaleMapped(outputPaths, to);
  // existing translations, for missing-key detection
  const existing = loadExisting(outputPaths, to);

  // Read only when the run uses it: a corrupt sidecar it never consults must not fail it.
  const useIncremental = options.incremental || Boolean(options.hashFile);
  const hashFilePath = sidecarPath(inputPath, options.hashFile, 'hash');
  const sidecar: Sidecar = useIncremental ? readSidecar(hashFilePath) : { locales: {}, owners: {}, attempts: {} };
  const hashStore: LocaleHashes = sidecar.locales;
  // Inputs sharing one sidecar are told apart by their path from it.
  const owner = ownerId(hashFilePath, inputPath);

  // load translation memory if enabled
  const useTranslationMemory = options.translationMemory || Boolean(options.translationMemoryFile);
  const tmFilePath = sidecarPath(inputPath, options.translationMemoryFile, 'tm');
  const memoryFile = useTranslationMemory ? loadTranslationMemory(tmFilePath) : { memory: {}, owners: {} };
  const translationMemory: TranslationMemory = memoryFile.memory;

  const glossaryModel = buildGlossaryModel(
    config.glossary,
    inlineGlossaryTerms,
    to,
    inputPath ? path.dirname(inputPath) : process.cwd(),
  );

  /** Writes what a run produced, unless it is a dry run or nothing landed to write. */
  const persist = (
    run: Pick<ObjectRun, 'locales' | 'hashes' | 'memory' | 'rejected'>,
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
    // Both files are read again here, not taken from the start of the run: another run in this
    // process may have saved since, and this one would erase what it recorded. Nothing between
    // this read and the write awaits, so within one process the merge cannot be interleaved.
    if (useIncremental && Object.keys(written).length > 0) {
      const current = readSidecar(hashFilePath);
      saveSidecar(
        hashFilePath,
        mergeRun(
          current,
          owner,
          sourceFlat,
          Object.keys(written),
          run,
          ownAttempts(current.attempts, owner),
          // `force` sends capped keys, so none was withheld.
          options.force ? {} : (capped ?? {}),
        ),
      );
    }
    if (useTranslationMemory) {
      const yielded = new Set(Object.entries(sourceFlat).map(([key, value]) => memoryKey(value, key, from)));
      const fresh = loadTranslationMemory(tmFilePath);
      const touched: TranslationMemory = { ...fresh.memory };
      for (const [key, locales] of Object.entries(run.memory)) {
        // An entry this run left as it found it is not its to restore: another run may have pruned it.
        const atStart = Object.hasOwn(translationMemory, key) ? translationMemory[key] : undefined;
        if (JSON.stringify(atStart) === JSON.stringify(locales)) continue;
        setOwn(touched, key, { ...(Object.hasOwn(fresh.memory, key) ? fresh.memory[key] : {}), ...locales });
      }
      const { memory, owners } = pruneMemory(
        { memory: touched, owners: fresh.owners },
        ownerId(tmFilePath, inputPath),
        yielded,
      );
      saveTranslationMemory(tmFilePath, memory, owners);
    }
    return written;
  };

  // What the run plans against: the caps from the sidecar as it was when the run started.
  const capped = useIncremental ? cappedKeys(ownAttempts(sidecar.attempts, owner), sourceFlat) : undefined;

  let run: ObjectRun;
  try {
    run = await translateObject(source, {
      from,
      to,
      namespace,
      config,
      existing,
      hashes: useIncremental ? hashStore : undefined,
      memory: useTranslationMemory ? translationMemory : undefined,
      glossary: glossaryModel ?? undefined,
      force: options.force,
      capped,
      dryRun: options.dryRun,
      engine: options.engine,
      logger: options.logger,
    });
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
      {
        locales: result.locales,
        hashes: result.hashes ?? {},
        memory: result.memory ?? {},
        rejected: result.rejected ?? {},
      },
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
 * An input's attempts after a run that wrote `written`: a key the run turned down counts one
 * more, unless its source changed since the last count. One that locale now holds, or the
 * source no longer has, has none. One not sent this time (capped, or its chunk failed) keeps its count.
 */
function countAttempts(
  own: Record<string, Record<string, Attempt>>,
  sourceFlat: Record<string, string>,
  written: string[],
  run: Pick<ObjectRun, 'hashes' | 'rejected'>,
  capped: Record<string, string[]>,
): Record<string, Record<string, Attempt>> {
  const next: Record<string, Record<string, Attempt>> = { ...own };
  for (const locale of written) {
    const before = Object.hasOwn(own, locale) ? own[locale] : {};
    const turnedDown = new Set(Object.hasOwn(run.rejected, locale) ? run.rejected[locale] : []);
    const withheld = new Set(Object.hasOwn(capped, locale) ? capped[locale] : []);
    const kept: Record<string, Attempt> = {};
    for (const key of Object.keys(sourceFlat)) {
      const hash = hashValue(sourceFlat[key]);
      const prior = Object.hasOwn(before, key) && before[key].hash === hash ? before[key] : undefined;
      if (turnedDown.has(key)) setOwn(kept, key, { hash, n: (prior?.n ?? 0) + 1 });
      else if (prior && (withheld.has(key) || localeStore(run.hashes, locale)?.[key] !== hash))
        setOwn(kept, key, prior);
    }
    if (Object.keys(kept).length > 0) setOwn(next, locale, kept);
    else delete next[locale];
  }
  return next;
}

/**
 * The sidecar after this input delivered `delivered`: their hashes merged in per owner, and
 * this input's key list moved to its current source. A key it dropped stays on the list
 * while a locale it did not deliver still holds it, so that locale's next run prunes it.
 */
function mergeRun(
  sidecar: Sidecar,
  ownerId: string,
  sourceFlat: Record<string, string>,
  delivered: string[],
  run: Pick<ObjectRun, 'hashes' | 'rejected'>,
  ownBefore: Record<string, Record<string, Attempt>>,
  capped: Record<string, string[]>,
): Sidecar {
  const sourceKeys = Object.keys(sourceFlat);
  const runHashes = run.hashes;
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
  const attempts: Attempts = { ...sidecar.attempts };
  const own = countAttempts(ownBefore, sourceFlat, delivered, run, capped);
  if (Object.keys(own).length > 0) setOwn(attempts, ownerId, own);
  else delete attempts[ownerId];
  return { locales, owners: { ...sidecar.owners, [ownerId]: [...owned] }, attempts };
}
