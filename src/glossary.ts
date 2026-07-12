import fs from 'node:fs';
import path from 'node:path';
import type { GlossaryConfig, GlossaryModel } from './types.js';
import { readJson } from './utils/json.js';

const MASK_PREFIX = '⟦';
const MASK_SUFFIX = '⟧';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(term: string): RegExp {
  // \b is ASCII-only; use Unicode-aware boundaries (\p{L}\p{N}_) to cover accented, CJK, and Cyrillic chars.
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'giu');
}

/**
 * Load glossary terms from a path relative to `baseDir`.
 * Directory  -> per-locale files `{path}/{locale}.json`, each `{ term: target }`.
 * File       -> combined `{ term: { locale: target } }`.
 * Missing    -> `{}`.
 */
export function loadGlossaryTerms(
  glossaryPath: string,
  locales: string[],
  baseDir: string,
): Record<string, Record<string, string>> {
  const abs = path.resolve(baseDir, glossaryPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return {};
  }

  if (stat.isDirectory()) {
    const terms: Record<string, Record<string, string>> = {};
    for (const locale of locales) {
      const file = path.join(abs, `${locale}.json`);
      if (!fs.existsSync(file)) continue;
      const map = readJson(file) as Record<string, string>;
      for (const [term, target] of Object.entries(map)) {
        if (!(term in terms)) terms[term] = {};
        terms[term][locale] = target;
      }
    }
    return terms;
  }

  return (readJson(abs) as Record<string, Record<string, string>>) ?? {};
}

/**
 * Resolve the effective glossary for a run.
 * Precedence: config.path (folder/file) > inlineTerms > none.
 * Returns null when there is neither term data nor a noTranslate list.
 */
export function buildGlossaryModel(
  config: GlossaryConfig | undefined,
  inlineTerms: Record<string, Record<string, string>> | undefined,
  locales: string[],
  baseDir: string,
): GlossaryModel | null {
  if (!config) return null;

  const terms = config.path ? loadGlossaryTerms(config.path, locales, baseDir) : (inlineTerms ?? {});
  const noTranslate = config.noTranslate ?? [];

  if (Object.keys(terms).length === 0 && noTranslate.length === 0) return null;
  return { terms, noTranslate };
}

/**
 * Build a system-prompt fragment instructing the model to use locked term translations.
 * Only includes terms that appear in `chunkText`, keeping the prompt small.
 */
export function buildGlossaryPromptBlock(
  terms: Record<string, Record<string, string>>,
  chunkText: string,
  targetLocales: string[],
): string {
  const present = findTermsInText(chunkText, Object.keys(terms));
  if (present.length === 0) return '';

  const lines: string[] = ['Use these exact term translations (glossary):'];
  for (const term of present) {
    const perLocale = targetLocales
      .filter((l) => terms[term][l])
      .map((l) => `${l}: ${terms[term][l]}`)
      .join(', ');
    if (perLocale) lines.push(`- "${term}" -> ${perLocale}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/** Terms actually present in `text`, longest-first (so overlaps resolve to the longer term). */
export function findTermsInText(text: string, terms: string[]): string[] {
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  return ordered.filter((term) => termRegex(term).test(text));
}

/**
 * Mask do-not-translate terms with T-prefixed sentinels (`⟦Tn⟧`).
 * Longest-first prevents a shorter term from masking inside a longer one.
 * The restore map preserves the matched occurrence's original casing.
 * T-prefix keeps sentinels disjoint from maskPlaceholders' `⟦n⟧` range.
 */
export function maskTerms(
  input: string,
  terms: string[],
  startCounter: number,
): { masked: string; map: Record<string, string>; nextCounter: number } {
  const map: Record<string, string> = {};
  let counter = startCounter;
  let result = input;
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  for (const term of ordered) {
    result = result.replace(termRegex(term), (match) => {
      const key = `${MASK_PREFIX}T${counter++}${MASK_SUFFIX}`;
      map[key] = match;
      return key;
    });
  }
  return { masked: result, map, nextCounter: counter };
}
