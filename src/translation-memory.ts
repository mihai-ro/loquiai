import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LoquiError } from './errors.js';
import type { TranslationMemory } from './types.js';
import { readJson, writeJson } from './utils/json.js';

const MEMORY_KEY_FORMAT = /^[0-9a-f]{32}$/;

/** Whether a memory key is a `memoryKey()`, as opposed to the 8-character hash v2 used. */
export function isMemoryKey(key: string): boolean {
  return MEMORY_KEY_FORMAT.test(key);
}

/**
 * The key a source string is remembered under. A 32-bit hash is fine for noticing that
 * one key's own text changed, but as the identity of a string across a whole project it
 * collides: two different strings would share one translation, silently.
 */
export function memoryKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Loads a translation memory from a JSON file.
 * Returns an empty translation memory if the file does not exist. A file with a key in
 * the old 8-character format is refused: the run would rewrite it without those entries
 * and the translations in them would be paid for again, so `loqui migrate` converts it first.
 */
export function loadTranslationMemory(tmPath: string): TranslationMemory {
  const data = readJson(tmPath) as TranslationMemory;
  const old = Object.keys(data).filter((key) => !isMemoryKey(key));
  if (old.length > 0) {
    throw new LoquiError(
      'INVALID_CONFIG',
      `${tmPath} holds ${old.length} translation-memory entr${old.length === 1 ? 'y' : 'ies'} in the v2 key format, which v3 does not read. Convert the file once with \`loqui migrate\`.`,
    );
  }
  return data;
}

/**
 * Saves a translation memory to a JSON file with 2-space indentation.
 * Creates parent directories if they don't exist.
 */
export function saveTranslationMemory(tmPath: string, tm: TranslationMemory): void {
  fs.mkdirSync(path.dirname(tmPath), { recursive: true });
  writeJson(tmPath, tm as Record<string, unknown>);
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
  const entry = tm[hash];
  if (!entry) return null;

  const result: Record<string, string> = {};
  for (const locale of locales) {
    if (locale in entry) result[locale] = entry[locale];
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
  if (!(hash in tm)) {
    tm[hash] = {};
  }
  Object.assign(tm[hash], translations);
}
