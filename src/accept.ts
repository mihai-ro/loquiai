import { findTermsInText } from './glossary.js';
import { restorePlaceholders } from './placeholder.js';
import type { GlossaryModel, RunWarning } from './types.js';

const SENTINEL = /⟦[^⟦⟧]*⟧/g;

function countSentinels(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [token] of text.matchAll(SENTINEL)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * What is wrong with the sentinels in a model's answer, or null when they match what was sent:
 * every sent one back exactly as often, and no other.
 */
function describePlaceholderFault(sent: string, answer: string, map: Record<string, string>): string | null {
  const sentCounts = countSentinels(sent);
  const answerCounts = countSentinels(answer);
  const original = (token: string): string =>
    Object.hasOwn(map, token) ? restorePlaceholders(map[token], map) : token;
  const list = (tokens: string[]): string => [...new Set(tokens.map(original))].join(', ');

  const missing = [...sentCounts.keys()].filter((token) => !answerCounts.has(token));
  const repeated = [...sentCounts].filter(([token, n]) => answerCounts.has(token) && answerCounts.get(token) !== n);
  const unsent = [...answerCounts.keys()].filter((token) => !sentCounts.has(token));

  const faults: string[] = [];
  if (missing.length > 0) faults.push(`is missing placeholders: ${list(missing)}`);
  if (repeated.length > 0)
    faults.push(`has placeholders a different number of times than sent: ${list(repeated.map(([t]) => t))}`);
  if (unsent.length > 0) faults.push(`has placeholders that were never sent: ${list(unsent)}`);
  return faults.length > 0 ? faults.join('; ') : null;
}

// Translations more than 4× the source length are almost certainly hallucinations.
const MAX_EXPANSION_RATIO = 4;

export interface AnswerInput {
  key: string;
  locale: string;
  from: string;
  namespace: string;
  /** what the model was sent for this key, masked. */
  sent: string;
  /** what the model answered for it, still masked. */
  answer: string;
  /** the restore map of the sent string. */
  map: Record<string, string>;
  /** the key's source text. */
  source: string;
  glossary?: GlossaryModel;
}

/** A turned-down answer always counts toward the retry cap, so it carries no flag for that. */
export type AnswerOutcome =
  | { accepted: true; value: string; warnings: RunWarning[] }
  | { accepted: false; warnings: RunWarning[] };

/** Whether one model answer may be written, with the warnings it earns. Pure: the caller logs and writes. */
export function acceptAnswer(input: AnswerInput): AnswerOutcome {
  const { key, locale, from, namespace, sent, answer, map, source, glossary } = input;
  const at = `[${namespace}→${locale}]`;
  const warn = (code: RunWarning['code'], message: string): RunWarning => ({ code, message, locale, key });

  const value = restorePlaceholders(answer, map);

  if (!value.trim()) {
    return { accepted: false, warnings: [warn('EMPTY_TRANSLATION', `${at} Empty translation for key: "${key}"`)] };
  }

  // Checked on the model's answer, before restore: a sentinel nested inside another
  // (a term or placeholder inside a tag) only exists in the map, never in the restored text.
  // The sentinels that count are the ones actually sent; nested ones ride along with their outer one.
  // Each must come back as often as it went out, and nothing else may look like one. Their
  // order is the translation's to change: `{name}` and `{count}` legitimately swap places.
  const fault = describePlaceholderFault(sent, answer, map);
  if (fault) {
    return {
      accepted: false,
      warnings: [warn('PLACEHOLDER_MISMATCH', `${at} Key "${key}" ${fault} — skipped, will retry on next run`)],
    };
  }

  // After the sentinel check, which names a well-formed one that was never sent. A value holding
  // either bracket is never sent, so one left after restore came from the model.
  if (value.includes('⟦') || value.includes('⟧')) {
    return {
      accepted: false,
      warnings: [
        warn(
          'PLACEHOLDER_MISMATCH',
          `${at} Key "${key}" has a stray ⟦ or ⟧ marker in the answer — skipped, will retry on next run`,
        ),
      ],
    };
  }

  // Glossary term-lock: the locked target term must appear in the translation.
  if (glossary) {
    // The text the model saw: a term inside a masked span (a tag's attribute) is not its to translate.
    const visible = sent.replace(SENTINEL, ' ');
    const sourceTerms = findTermsInText(visible, Object.keys(glossary.terms));
    const missingTerms = sourceTerms.filter((term) => {
      const perLocale = glossary.terms[term];
      const locked = perLocale && Object.hasOwn(perLocale, locale) ? perLocale[locale] : undefined;
      return locked && !value.toLowerCase().includes(locked.toLowerCase());
    });
    if (missingTerms.length > 0) {
      return {
        accepted: false,
        warnings: [
          warn(
            'MISSING_GLOSSARY_TERM',
            `${at} Key "${key}" missing glossary term(s): ${missingTerms.join(', ')} — skipped, will retry on next run`,
          ),
        ],
      };
    }
  }

  const warnings: RunWarning[] = [];

  // Untranslated detection: value identical to source suggests the model
  // returned the input unchanged. Warn but save — could be a proper noun.
  if (locale !== from && source.trim() !== '' && value.trim() === source.trim()) {
    warnings.push(warn('UNTRANSLATED', `${at} Key "${key}" appears untranslated (identical to source)`));
  }

  // Length explosion: ratio > 4× source is almost certainly a hallucination.
  if (source.length > 0 && value.length > source.length * MAX_EXPANSION_RATIO) {
    const ratio = Math.round(value.length / source.length);
    warnings.push(
      warn('LENGTH_RATIO', `${at} Key "${key}" translation is ${ratio}× source length — possible hallucination`),
    );
  }

  return { accepted: true, value, warnings };
}
