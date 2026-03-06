/**
 * 05-namespaced-batch.ts
 *
 * Translate an entire i18n directory organised as:
 *   src/assets/i18n/:namespace/:locale.json
 *
 * Each namespace is translated independently, in sequence.
 * Incremental mode is on so only changed keys are sent to the API.
 *
 * Run:
 *   GEMINI_API_KEY=... npx ts-node examples/05-namespaced-batch.ts
 */

import { translate } from '@mihairo/loqui';
import { readdirSync } from 'fs';
import { join } from 'path';

const I18N_DIR = 'src/assets/i18n';
const FROM = 'en';
const TO = ['fr', 'de', 'es', 'ja'];

const namespaces = readdirSync(I18N_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

console.log(`Translating ${namespaces.length} namespace(s): ${namespaces.join(', ')}`);

for (const ns of namespaces) {
  await translate({
    input: join(I18N_DIR, ns, `${FROM}.json`),
    from: FROM,
    to: TO,
    output: join(I18N_DIR, ns, '{locale}.json'),
    namespace: ns,
    incremental: true,
  });
}
