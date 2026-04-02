import fs from 'node:fs';
import path from 'node:path';
import type { Glossary } from './types.js';
import { readJson, writeJson } from './utils/json.js';

/**
 * Loads a glossary from a JSON file.
 * Returns an empty glossary if the file doesn't exist.
 */
export function loadGlossary(glossaryPath: string): Glossary {
  const data = readJson(glossaryPath);
  return data as Glossary;
}

/**
 * Saves a glossary to a JSON file with 2-space indentation.
 * Creates parent directories if they don't exist.
 */
export function saveGlossary(glossaryPath: string, glossary: Glossary): void {
  fs.mkdirSync(path.dirname(glossaryPath), { recursive: true });
  writeJson(glossaryPath, glossary as Record<string, unknown>);
}

/**
 * Looks up a hash in the glossary.
 * Returns translations for all requested locales if present, otherwise null.
 */
export function lookupGlossary(glossary: Glossary, hash: string, locales: string[]): Record<string, string> | null {
  const entry = glossary[hash];
  if (!entry) return null;

  // Check if all requested locales are present
  const missing = locales.filter((locale) => !(locale in entry));
  if (missing.length > 0) return null;

  // Return translations for all requested locales
  const result: Record<string, string> = {};
  for (const locale of locales) {
    result[locale] = entry[locale];
  }
  return result;
}

/**
 * Adds or updates translations for a hash in the glossary.
 */
export function updateGlossary(glossary: Glossary, hash: string, translations: Record<string, string>): void {
  if (!(hash in glossary)) {
    glossary[hash] = {};
  }
  Object.assign(glossary[hash], translations);
}
