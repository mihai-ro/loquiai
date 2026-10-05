import type { FlatTranslations } from './types.js';
import { isUntranslated } from './untranslated.js';

export interface ValidationResult {
  locale: string;
  /** The locale has no target file. Every source key is then under `missing`. */
  fileMissing: boolean;
  missing: string[];
  extra: string[];
  ok: string[];
}

export function validateLocales(
  sourceFlat: FlatTranslations,
  existing: Record<string, FlatTranslations>,
  locales: string[],
): ValidationResult[] {
  const sourceKeys = new Set(Object.keys(sourceFlat));
  const results: ValidationResult[] = [];

  for (const locale of locales) {
    const fileMissing = !Object.hasOwn(existing, locale);
    const targetFlat = fileMissing ? {} : existing[locale];
    const targetKeys = new Set(Object.keys(targetFlat));

    const missing: string[] = [];
    const extra: string[] = [];
    const ok: string[] = [];

    for (const key of sourceKeys) {
      if (targetKeys.has(key) && !isUntranslated(sourceFlat[key], targetFlat[key])) {
        ok.push(key);
      } else {
        missing.push(key);
      }
    }

    for (const key of targetKeys) {
      if (!sourceKeys.has(key)) {
        extra.push(key);
      }
    }

    missing.sort();
    extra.sort();
    ok.sort();

    results.push({ locale, fileMissing, missing, extra, ok });
  }

  return results;
}
