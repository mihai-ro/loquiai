import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LoquiError } from './errors.js';
import { readOwners } from './hasher.js';
import type { TranslationMemory } from './types.js';
import { readJson, setOwn, splitFlatKey, writeJson } from './utils/json.js';

const MEMORY_KEY_FORMAT = /^[0-9a-f]{32}$/;

/** Whether a memory key is a `memoryKey()`, as opposed to the 8-character hash v2 used. */
export function isMemoryKey(key: string): boolean {
  return MEMORY_KEY_FORMAT.test(key);
}

/**
 * The key a source string is remembered under, in the context of the flat key it sits at.
 * A 32-bit hash is fine for noticing that one key's own text changed, but as the identity
 * of a string across a whole project it collides: two different strings would share one
 * translation, silently.
 *
 * The context is the key's parent path, what the model reads around the string: `Save`
 * under `buttons` and under `menu` can need different words, while siblings and array
 * items under one parent share an entry. The key's own name and the file's namespace stay
 * out of it: the first would give every key its own entry, the second would stop inputs
 * that share a memory file from sharing what they know.
 */
export function memoryKey(value: string, flatKey: string, from: string): string {
  const context = splitFlatKey(flatKey).slice(0, -1).join('\0');
  return createHash('sha256').update(`${from}\0${value}\0${context}`).digest('hex').slice(0, 32);
}

/** What a memory file holds: the entries, and which input listed which of them. */
export interface MemoryFile {
  memory: TranslationMemory;
  /** Owner id → the memory keys that input's source yielded when it last saved. */
  owners: Record<string, string[]>;
}

/**
 * Loads a translation memory from a JSON file. The top-level `$owners` key is the file's
 * own bookkeeping and is never read as an entry.
 * Returns an empty translation memory if the file does not exist. A file with a key in
 * the old 8-character format is refused: the run would rewrite it without those entries
 * and the translations in them would be paid for again, so `loqui migrate` converts it first.
 */
export function loadTranslationMemory(tmPath: string): MemoryFile {
  const data = readJson(tmPath) as Record<string, unknown>;
  const keys = Object.keys(data).filter((key) => !key.startsWith('$'));
  const old = keys.filter((key) => !isMemoryKey(key));
  if (old.length > 0) {
    throw new LoquiError(
      'INVALID_CONFIG',
      `${tmPath} holds ${old.length} translation-memory entr${old.length === 1 ? 'y' : 'ies'} in the v2 key format, which v3 does not read. Convert the file once with \`loqui migrate\`.`,
    );
  }
  const memory: TranslationMemory = {};
  for (const key of keys) setOwn(memory, key, data[key]);
  return { memory, owners: readOwners(data.$owners) };
}

/**
 * Saves a translation memory to a JSON file with 2-space indentation.
 * Creates parent directories if they don't exist.
 */
export function saveTranslationMemory(
  tmPath: string,
  tm: TranslationMemory,
  owners: Record<string, string[]> = {},
): void {
  fs.mkdirSync(path.dirname(tmPath), { recursive: true });
  const bookkeeping = Object.keys(owners).length > 0 ? { $owners: owners } : {};
  writeJson(tmPath, { ...tm, ...bookkeeping });
}

/**
 * The file after `owner` saved a run whose source yields `yielded`: the entries it listed
 * before and no longer yields are dropped, unless another input lists them (memory keys are
 * shared across inputs), and its list becomes `yielded`. Entries nobody lists, from a file
 * that predates owners, are kept: nothing says whose they are.
 */
export function pruneMemory(file: MemoryFile, owner: string, yielded: ReadonlySet<string>): MemoryFile {
  const before = Object.hasOwn(file.owners, owner) ? file.owners[owner] : [];
  const listedByOthers = new Set(Object.entries(file.owners).flatMap(([id, keys]) => (id === owner ? [] : keys)));
  const memory = { ...file.memory };
  for (const key of before) {
    if (!yielded.has(key) && !listedByOthers.has(key)) delete memory[key];
  }
  return { memory, owners: { ...file.owners, [owner]: [...yielded] } };
}

/**
 * Looks up a hash in the translation memory.
 *
 * Returns whatever is cached for the requested locales, which may be a subset —
 * demanding all of them means a key only `fr` needs misses the memory whenever `de`
 * happens to lack it, and the caller pays to translate something already known.
 * Returns null when nothing is cached for any of them.
 */
export function lookupTranslationMemory(
  tm: TranslationMemory,
  hash: string,
  locales: string[],
): Record<string, string> | null {
  if (!Object.hasOwn(tm, hash)) return null;
  const entry = tm[hash];

  const result: Record<string, string> = {};
  for (const locale of locales) {
    if (Object.hasOwn(entry, locale)) result[locale] = entry[locale];
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Adds or updates translations for a hash in the translation memory.
 */
export function updateTranslationMemory(
  tm: TranslationMemory,
  hash: string,
  translations: Record<string, string>,
): void {
  if (!Object.hasOwn(tm, hash)) setOwn(tm, hash, {});
  Object.assign(tm[hash], translations);
}
