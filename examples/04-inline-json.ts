/**
 * 04-inline-json.ts
 *
 * Pass a raw JSON string as input instead of a file path.
 * Useful for translating strings you already have in memory —
 * no temp files needed.
 *
 * Run:
 *   GEMINI_API_KEY=... npx ts-node examples/04-inline-json.ts
 */

import { translate } from 'falar';

const source = JSON.stringify({
  welcome: 'Welcome back, {{name}}!',
  logout: 'Sign out',
  itemCount: '{count, plural, one {# item} other {# items}}',
});

const result = await translate({
  input: source,   // raw JSON string — detected automatically
  from: 'en',
  to: ['fr', 'es'],
});

for (const [locale, json] of Object.entries(result)) {
  console.log(`\n--- ${locale} ---`);
  console.log(json);
}
