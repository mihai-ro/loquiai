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
 * Returns translations for all requested locales if present, otherwise null.
 */
export function lookupTranslationMemory(
  tm: TranslationMemory,
  hash: string,
  locales: string[],
): Record<string, string> | null {
  const entry = tm[hash];
  if (!entry) return null;

  const missing = locales.filter((locale) => !(locale in entry));
  if (missing.length > 0) return null;

  const result: Record<string, string> = {};
  for (const locale of locales) {
    result[locale] = entry[locale];
  }
  return result;
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
