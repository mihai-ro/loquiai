/**
 * 03-incremental.ts
 *
 * Incremental mode: only keys that are new or whose source text has changed
 * since the last run are sent to the LLM. Everything else is left untouched,
 * including any manual edits a native speaker may have made to the target files.
 *
 * A hash sidecar file (.en.loqui-hash.json) is created next to the input
 * file automatically. On subsequent runs it is used to detect changes.
 *
 * Run twice to see the difference:
 *   GEMINI_API_KEY=... npx ts-node examples/03-incremental.ts
 */

import { translate } from '@mihairo/loqui';

await translate({
  input: './en.json',
  from: 'en',
  to: ['fr', 'de'],
  output: './i18n/{locale}.json',
  incremental: true,   // only re-translate what changed
});
