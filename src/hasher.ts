import fs from 'node:fs';
import path from 'node:path';
import type { HashStore, LocaleHashes } from './types.js';
import { readJson, writeJson } from './utils/json.js';

/**
 * Reads the sidecar as one store per locale in `to`. A v2 sidecar is a single flat store
 * (its values are strings) and is applied to every locale in `to`: it never said which
 * locale a hash was for, so each of them has to inherit it. Locales outside `to` get nothing.
 */
export function loadHashStore(hashFile: string, to: string[]): LocaleHashes {
  const raw = readJson(hashFile) as Record<string, unknown>;
  if (Object.values(raw).some((value) => typeof value === 'string')) {
    return Object.fromEntries(to.map((locale) => [locale, { ...(raw as HashStore) }]));
  }
  return raw as LocaleHashes;
}

export function saveHashStore(hashFile: string, store: LocaleHashes): void {
  fs.mkdirSync(path.dirname(hashFile), { recursive: true });
  writeJson(hashFile, store);
}

/** A locale's own store, never one inherited from `Object.prototype`. */
export function localeStore(hashes: LocaleHashes | undefined, locale: string): HashStore | undefined {
  return hashes && Object.hasOwn(hashes, locale) ? hashes[locale] : undefined;
}

/**
 * FNV-1a 32-bit hash — fast, zero-allocation, no imports.
 * Sufficient collision resistance for i18n change detection.
 * Output: 8 lowercase hex characters.
 */
export function hashValue(value: string): string {
  let h = 2166136261; // FNV-32 offset basis
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0; // FNV-32 prime, keep uint32
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The sidecar after a run: for each locale in `to`, the current source hash of every key
 * that locale has nothing outstanding for, and the stored hash of the rest. A key the
 * source no longer has is dropped, or the sidecar only ever grows. A key a locale still
 * owes keeps its old hash (or none), so the next run sees it as outstanding for that
 * locale. Locales outside `to` pass through untouched.
 */
export function buildUpdatedHashes(
  previous: LocaleHashes,
  to: string[],
  currentHashes: HashStore,
  outstanding: (locale: string, key: string) => boolean,
): LocaleHashes {
  const updated: LocaleHashes = { ...previous };
  for (const locale of to) {
    const before = localeStore(previous, locale) ?? {};
    const store: HashStore = {};
    for (const [key, hash] of Object.entries(currentHashes)) {
      if (!outstanding(locale, key)) store[key] = hash;
      else if (Object.hasOwn(before, key)) store[key] = before[key];
    }
    updated[locale] = store;
  }
  return updated;
}
