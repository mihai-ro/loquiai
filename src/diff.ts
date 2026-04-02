import type { FlatTranslations } from './types.js';

/** Result of comparing source against a target locale. */
export interface DiffResult {
  /** Target locale code. */
  locale: string;
  /** Keys in source but not in target (need translation). */
  added: string[];
  /** Keys in target but not in source (likely removed from source). */
  removed: string[];
  /** Keys in both but with different source values (need re-translation). */
  changed: string[];
  /** Keys in both and identical (unchanged). */
  unchanged: string[];
}

/**
 * Compares source translations against existing target locales.
 * Reports added, removed, changed, and unchanged keys.
 */
export function diffLocales(sourceFlat: FlatTranslations, existing: Record<string, FlatTranslations>): DiffResult[] {
  const sourceKeys = new Set(Object.keys(sourceFlat));

  const results: DiffResult[] = [];

  for (const [locale, targetFlat] of Object.entries(existing)) {
    const targetKeys = new Set(Object.keys(targetFlat));

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    // Find added (in source but not in target)
    for (const key of sourceKeys) {
      if (!targetKeys.has(key)) {
        added.push(key);
      }
    }

    // Find removed and changed (in target but not in source, or changed value)
    for (const key of targetKeys) {
      if (!sourceKeys.has(key)) {
        removed.push(key);
      } else if (sourceFlat[key] !== targetFlat[key]) {
        changed.push(key);
      } else {
        unchanged.push(key);
      }
    }

    results.push({ locale, added, removed, changed, unchanged });
  }

  return results;
}
