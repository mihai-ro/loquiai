/**
 * 02-multiple-locales.ts
 *
 * Translate one source file into several languages at once and write each
 * to its own output file using the {locale} path template.
 *
 * Run:
 *   GEMINI_API_KEY=... npx ts-node examples/02-multiple-locales.ts
 */

import { translate } from '@mihairo/loqui';

const { locales, written } = await translate({
  input: './en.json',
  from: 'en',
  to: ['es', 'pt', 'de', 'ja'],
  output: './i18n/{locale}.json',   // writes i18n/es.json, i18n/pt.json, …
});

for (const [locale, doc] of Object.entries(locales)) {
  const keyCount = Object.keys(doc).length;
  console.log(`${locale}: ${keyCount} keys written to ${written[locale]}`);
}
