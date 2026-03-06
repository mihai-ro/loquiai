/**
 * 09-dry-run.ts
 *
 * Dry-run mode lets you preview exactly which keys would be translated
 * and to which locales, without making any API calls or writing any files.
 * Useful for CI checks or auditing translation coverage.
 *
 * Run:
 *   npx ts-node examples/09-dry-run.ts
 */

import { translate } from 'falar';
import { existsSync } from 'fs';
import { join } from 'path';

const namespaces = ['common', 'auth', 'dashboard'];
const locales = ['fr', 'de', 'es'];
const I18N_DIR = 'src/assets/i18n';

for (const ns of namespaces) {
  const input = join(I18N_DIR, ns, 'en.json');
  if (!existsSync(input)) {
    console.log(`[${ns}] skipped — no en.json`);
    continue;
  }

  // dryRun: logs what would be translated, makes zero API calls, writes nothing
  await translate({
    input,
    from: 'en',
    to: locales,
    output: join(I18N_DIR, ns, '{locale}.json'),
    namespace: ns,
    incremental: true,
    dryRun: true,
  });
}
