// Resolves the package by its own name through `exports`, the way a consumer's
// TypeScript does, so a broken `types` condition shows up here.
import {
  BaseEngine,
  type DiffReport,
  type EngineAdapter,
  type DiffResult,
  diff,
  type InspectOptions,
  type JsonObject,
  type LogFn,
  LoquiError,
  type LoquiConfig,
  type ReviewChunkRequest,
  stderrLogger,
  type TranslateChunkRequest,
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

// A custom engine, plain and as a BaseEngine subclass: both take the request object.
const engine: EngineAdapter = {
  async translateChunk(req: TranslateChunkRequest) {
    req.log('debug', 'sent');
    req.onRateLimited();
    return Object.fromEntries(req.targetLocales.map((locale) => [locale, { keys: req.chunk.keys }]));
  },
  async reviewChunk(req: ReviewChunkRequest) {
    return req.initial;
  },
};

class SubclassEngine extends BaseEngine {
  constructor(config: LoquiConfig) {
    super(config, 'key');
  }

  protected async makeCall(
    _system: string,
    _user: string,
    expectedKeys: string[],
    targetLocales: string[],
    ctx: Pick<TranslateChunkRequest, 'log' | 'onRateLimited'>,
  ) {
    return this.extractTranslations({}, expectedKeys, targetLocales, ctx);
  }
}

// Controls, so this cannot pass by resolving to `any`: translate is not a string, and
// the CLI is not an export. An unused directive here is an error.
// @ts-expect-error translate is a function
const notAString: string = translate;
// @ts-expect-error './cli' is not exported
import type {} from '@mihairo/loqui/cli';

export { changes, checks, core, engine, logger, notAString, result, run, SubclassEngine };
