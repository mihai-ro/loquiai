/**
 * A target value is untranslated when it is blank while the source has text. Tools such
 * as i18next-parser write "" for every new key, so a blank value is a placeholder, not an
 * answer. One rule, used wherever a target is read: translating, validating, diffing.
 * A blank source with a blank target is not untranslated: there is nothing to translate.
 */
export function isUntranslated(sourceValue: string, targetValue: string): boolean {
  return targetValue.trim() === '' && sourceValue.trim() !== '';
}
