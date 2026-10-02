import { hashValue } from './hasher.js';
import type { FlatTranslations, HashStore } from './types.js';
import { isUntranslated } from './untranslated.js';

/** Result of comparing source against a target locale. */
export interface DiffResult {
  /** Target locale code. */
  locale: string;
  /** Keys in source but not in target (need translation). */
  added: string[];
  /** Keys in target but not in source (likely removed from source). */
  removed: string[];
  /** Keys in both whose SOURCE text changed since the last run (need re-translation). */
  changed: string[];
  /** Keys in both whose source is unchanged since the last run. */
  unchanged: string[];
}

/**
 * Compares source translations against existing target locales.
 * Reports added, removed, changed, and unchanged keys.
 *
 * "Changed" means the source text moved since the last run, which is what the hash
 * sidecar records. Comparing the source against the target value instead would call
 * every correctly translated key "changed" and every untranslated one "unchanged".
 * Without a hash store there is no record of the previous source, so nothing can be
 * reported as changed — the caller is expected to say so.
 */
export function diffLocales(
  sourceFlat: FlatTranslations,
  existing: Record<string, FlatTranslations>,
  hashStore: HashStore = {},
): DiffResult[] {
  const sourceKeys = new Set(Object.keys(sourceFlat));

  const results: DiffResult[] = [];

  for (const [locale, targetFlat] of Object.entries(existing)) {
    const targetKeys = new Set(Object.keys(targetFlat));

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    // Find added (in source but not in target, or in the target as a blank placeholder)
    for (const key of sourceKeys) {
      if (!targetKeys.has(key) || isUntranslated(sourceFlat[key], targetFlat[key])) {
        added.push(key);
      }
    }

    // Find removed and changed (in target but not in source, or changed value)
    for (const key of targetKeys) {
      if (!sourceKeys.has(key)) {
        removed.push(key);
      } else if (!isUntranslated(sourceFlat[key], targetFlat[key])) {
        const previousHash = hashStore[key];
        const sourceChanged = previousHash !== undefined && previousHash !== hashValue(sourceFlat[key]);
        if (sourceChanged) changed.push(key);
        else unchanged.push(key);
      }
    }

    results.push({ locale, added, removed, changed, unchanged });
  }

  return results;
}
