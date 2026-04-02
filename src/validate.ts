import type { FlatTranslations } from './types.js';

export interface ValidationResult {
  locale: string;
  missing: string[];
  extra: string[];
  ok: string[];
}

export function validateLocales(
  sourceFlat: FlatTranslations,
  existing: Record<string, FlatTranslations>,
): ValidationResult[] {
  const sourceKeys = new Set(Object.keys(sourceFlat));
  const results: ValidationResult[] = [];

  for (const [locale, targetFlat] of Object.entries(existing)) {
    const targetKeys = new Set(Object.keys(targetFlat));

    const missing: string[] = [];
    const extra: string[] = [];
    const ok: string[] = [];

    for (const key of sourceKeys) {
      if (targetKeys.has(key)) {
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

    results.push({ locale, missing, extra, ok });
  }

  return results;
}
