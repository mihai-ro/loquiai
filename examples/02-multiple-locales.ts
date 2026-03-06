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

const result = await translate({
  input: './en.json',
  from: 'en',
  to: ['fr', 'de', 'es', 'ja', 'pt'],
  output: './i18n/{locale}.json',   // writes i18n/fr.json, i18n/de.json, …
});

for (const [locale, json] of Object.entries(result)) {
  const keyCount = Object.keys(JSON.parse(json)).length;
  console.log(`${locale}: ${keyCount} keys written`);
}
