// Resolves the package by its own name through `exports`, the way a consumer's
// TypeScript does, so a broken `types` condition shows up here.
import {
  type DiffReport,
  type DiffResult,
  diff,
  type InspectOptions,
  type JsonObject,
  type LogFn,
  LoquiError,
  stderrLogger,
  type TranslationRun,
  translate,
  translateObject,
  type ValidationResult,
  validate,
} from '@mihairo/loqui';

const run: (...args: never[]) => Promise<TranslationRun> = translate;
const core: (source: JsonObject, options: { from: string; to: string[] }) => Promise<TranslationRun> = translateObject;
const inspect: InspectOptions = { input: './en.json', to: ['es'], output: './i18n/{locale}.json' };
const report: DiffReport = diff(inspect);
const changes: DiffResult[] = report.results;
const checks: ValidationResult[] = validate(inspect);
const logger: LogFn = stderrLogger;
const result: TranslationRun | undefined = new LoquiError('CHUNK_FAILED', 'x').result;

// Controls, so this cannot pass by resolving to `any`: translate is not a string, and
// the CLI is not an export. An unused directive here is an error.
// @ts-expect-error translate is a function
const notAString: string = translate;
// @ts-expect-error './cli' is not exported
import type {} from '@mihairo/loqui/cli';

export { changes, checks, core, logger, notAString, result, run };
