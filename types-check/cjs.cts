// The same through `require`, which TypeScript resolves under the `require` condition.
import loqui = require('@mihairo/loqui');

const run: (...args: never[]) => Promise<loqui.TranslationRun> = loqui.translate;
const core: (source: loqui.JsonObject, options: { from: string; to: string[] }) => Promise<loqui.TranslationRun> =
  loqui.translateObject;
const inspect: loqui.InspectOptions = { input: './en.json', to: ['es'], output: './i18n/{locale}.json' };
const report: loqui.DiffReport = loqui.diff(inspect);
const changes: loqui.DiffResult[] = report.results;
const checks: loqui.ValidationResult[] = loqui.validate(inspect);
const logger: loqui.LogFn = loqui.stderrLogger;
const result: loqui.TranslationRun | undefined = new loqui.LoquiError('CHUNK_FAILED', 'x').result;

// @ts-expect-error translate is a function
const notAString: string = loqui.translate;
// @ts-expect-error './cli' is not exported
import type {} from '@mihairo/loqui/cli';

export = { changes, checks, core, logger, notAString, result, run };
