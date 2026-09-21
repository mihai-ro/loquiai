import fs from 'node:fs';
import path from 'node:path';
import type { TranslationMemory } from './types.js';
import { readJson, writeJson } from './utils/json.js';

/**
 * Loads a translation memory from a JSON file.
 * Returns an empty translation memory if the file does not exist.
 */
export function loadTranslationMemory(tmPath: string): TranslationMemory {
  const data = readJson(tmPath);
  return data as TranslationMemory;
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
