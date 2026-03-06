/**
 * 01-basic.ts
 *
 * The simplest possible usage: translate a JSON file into one language
 * and print the result to stdout.
 *
 * Run:
 *   GEMINI_API_KEY=... npx ts-node examples/01-basic.ts
 */

import { translate } from 'falar';

const result = await translate({
  input: './en.json',
  from: 'en',
  to: 'fr',
});

console.log(result['fr']);
