import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TranslationMemory } from './types.js';
import { readJson, writeJson } from './utils/json.js';
import { logger } from './utils/logger.js';

const MEMORY_KEY_FORMAT = /^[0-9a-f]{32}$/;

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
 * Returns an empty translation memory if the file does not exist.
 */
export function loadTranslationMemory(tmPath: string): TranslationMemory {
  const data = readJson(tmPath) as TranslationMemory;
  // Entries from before keys became memoryKey()s are 8-character hashes that can never
  // match again; keeping them would only carry dead weight into every rewrite.
  const current: TranslationMemory = {};
  let dropped = 0;
  for (const [key, entry] of Object.entries(data)) {
    if (MEMORY_KEY_FORMAT.test(key)) current[key] = entry;
    else dropped++;
  }
  if (dropped > 0) {
    logger.warn(
      `${tmPath}: ignored ${dropped} translation-memory entr${dropped === 1 ? 'y' : 'ies'} in the old key format.`,
    );
  }
  return current;
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
