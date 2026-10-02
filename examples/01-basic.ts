/**
 * 01-basic.ts
 *
 * The simplest possible usage: translate a JSON file into one language
 * and print the translated document.
 *
 * Run:
 *   GEMINI_API_KEY=... npx ts-node examples/01-basic.ts
 */

import { translate } from '@mihairo/loqui';

const { locales } = await translate({
  input: './en.json',
  from: 'en',
  to: 'es',
});

console.log(JSON.stringify(locales.es, null, 2));
