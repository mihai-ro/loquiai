import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { BaseEngine } from './engines/base.engine.js';
import { fetchWithRetry } from './engines/utils.js';
import { translate } from './lib.js';
import { translateJson } from './translator.js';
import {
  CONFIG_DEFAULTS,
  type EngineAdapter,
  type LoquiConfig,
  type TranslationChunk,
  type TranslationResult,
} from './types.js';
import type { LogFn, LogLevel } from './utils/logger.js';

const config: LoquiConfig = { ...CONFIG_DEFAULTS };

interface Entry {
  level: LogLevel;
  message: string;
}

function collector(): { log: LogFn; entries: Entry[]; at: (level: LogLevel) => string[] } {
  const entries: Entry[] = [];
  return {
    log: (level, message) => {
      entries.push({ level, message });
    },
    entries,
    at: (level) => entries.filter((e) => e.level === level).map((e) => e.message),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Answers every key in the first locale only. The engine's own parse step then warns
 * about the locales it lacks, and the run warns about each empty value.
 */
class PartialEngine extends BaseEngine {
  constructor(private readonly respondTo: string[]) {
    super({ ...CONFIG_DEFAULTS }, 'test-key');
  }

  protected async makeCall(
    _system: string,
    _user: string,
    expectedKeys: string[],
    targetLocales: string[],
  ): Promise<Record<string, TranslationResult>> {
    await tick();
    const answer = Object.fromEntries(
      this.respondTo.map((l) => [l, Object.fromEntries(expectedKeys.map((k) => [k, 'x']))]),
    );
    return this.extractTranslations(answer, expectedKeys, targetLocales);
  }
}

/** Fails once with a 503, then answers: a run through this engine logs one retry. */
class RetryingEngine extends PartialEngine {
  #calls = 0;

  constructor() {
    super(['es']);
    this._setFetch(
      async () => new Response(++this.#calls === 1 ? 'busy' : '{}', { status: this.#calls === 1 ? 503 : 200 }),
    );
  }

  protected override async makeCall(
    system: string,
    user: string,
    expectedKeys: string[],
    targetLocales: string[],
  ): Promise<Record<string, TranslationResult>> {
    await fetchWithRetry('https://example.invalid/v1', {}, { ...this.retryHooks(), maxRetries: 2, engineName: 'Test' });
    return super.makeCall(system, user, expectedKeys, targetLocales);
  }
}

/** Records what reaches either stream while still forwarding it, so the test reporter is unharmed. */
async function streamsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const spy =
    (real: typeof process.stdout.write) =>
    (chunk: string | Uint8Array, ...rest: unknown[]) => {
      seen.push(String(chunk));
      return (real as (...args: unknown[]) => boolean).call(
        real === realOut ? process.stdout : process.stderr,
        chunk,
        ...rest,
      );
    };
  process.stdout.write = spy(realOut) as typeof process.stdout.write;
  process.stderr.write = spy(realErr) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return seen;
}

let configDir: string;

before(async () => {
  configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loqui-logging-'));
});

after(async () => {
  await fs.promises.rm(configDir, { recursive: true, force: true });
});

const runOptions = (extra: { logger?: LogFn; engine: EngineAdapter }) => ({
  input: '{"a":"Hello","b":"World"}',
  from: 'en',
  to: ['es', 'pt'],
  namespace: 'quiet',
  configPath: configDir,
  ...extra,
});

describe('a run that is given no logger', () => {
  test('writes nothing to stdout or stderr, even when it warns and retries', async () => {
    const given = collector();
    await translate(runOptions({ logger: given.log, engine: new RetryingEngine() }));
    // the same run, observed through a logger, tells us what it would have said
    assert.ok(given.at('warn').length > 0, 'the run should have warned');
    assert.ok(
      given.at('debug').some((m) => m.includes('[retry]')),
      'the run should have retried',
    );

    const seen = await streamsDuring(() => translate(runOptions({ engine: new RetryingEngine() })));

    for (const entry of given.entries) {
      for (const chunk of seen) assert.ok(!chunk.includes(entry.message), `leaked to a stream: ${entry.message}`);
    }
  });

  test('a run given a logger writes nothing to the streams either', async () => {
    const given = collector();
    const seen = await streamsDuring(() => translate(runOptions({ logger: given.log, engine: new RetryingEngine() })));

    for (const entry of given.entries) {
      for (const chunk of seen) assert.ok(!chunk.includes(entry.message), `leaked to a stream: ${entry.message}`);
    }
  });
});

describe('the messages a logger receives', () => {
  test('at warn they are exactly stats.warnings, the engine own warnings included', async () => {
    const given = collector();

    const { stats } = await translateJson({
      sourceFlat: { a: 'Hello', b: 'World' },
      from: 'en',
      to: ['es', 'pt'],
      namespace: 'quiet',
      config,
      engine: new PartialEngine(['es']),
      logger: given.log,
    });

    assert.ok(
      stats.warnings.some((w) => w.includes('Engine response missing locale "pt"')),
      'engine warning missing',
    );
    assert.ok(
      stats.warnings.some((w) => w.includes('Empty translation')),
      'run warning missing',
    );
    assert.deepEqual(given.at('warn'), stats.warnings);
  });

  test('progress arrives at info and per-chunk detail at debug', async () => {
    const given = collector();

    await translateJson({
      sourceFlat: { a: 'Hello' },
      from: 'en',
      to: ['es'],
      namespace: 'quiet',
      config,
      engine: new PartialEngine(['es']),
      logger: given.log,
    });

    assert.ok(given.at('info').some((m) => m.includes('Translating 1 key(s)')));
    assert.ok(given.at('debug').some((m) => m.includes('Chunk 1/1 done')));
  });

  test('a retry is reported at debug', async () => {
    const given = collector();

    await translateJson({
      sourceFlat: { a: 'Hello' },
      from: 'en',
      to: ['es'],
      namespace: 'quiet',
      config,
      engine: new RetryingEngine(),
      logger: given.log,
    });

    assert.ok(given.at('debug').some((m) => m.startsWith('[retry] Test 503')));
  });

  test('warnings raised before the run are recorded and logged ahead of its progress', async () => {
    const given = collector();

    const { stats } = await translateJson({
      sourceFlat: { a: 'Hello' },
      from: 'en',
      to: ['es'],
      namespace: 'quiet',
      config,
      engine: new PartialEngine(['es']),
      preRunWarnings: ['memory.json: ignored 2 translation-memory entries in the old key format.'],
      logger: given.log,
    });

    assert.deepEqual(stats.warnings, ['memory.json: ignored 2 translation-memory entries in the old key format.']);
    assert.equal(given.entries[0].level, 'warn');
  });

  test('the log it hands back records into the same run', async () => {
    const given = collector();

    const { stats, log } = await translateJson({
      sourceFlat: { a: 'Hello' },
      from: 'en',
      to: ['es'],
      namespace: 'quiet',
      config,
      engine: new PartialEngine(['es']),
      logger: given.log,
    });
    log('warn', 'after the run');
    log('debug', 'not a warning');

    assert.equal(stats.warnings.at(-1), 'after the run');
    assert.ok(!stats.warnings.includes('not a warning'));
    assert.deepEqual(given.at('warn'), stats.warnings);
  });
});

describe('two runs at once', () => {
  test('each logger receives only its own run, engine messages included', async () => {
    const a = collector();
    const b = collector();

    await Promise.all([
      translateJson({
        sourceFlat: { a1: 'one' },
        from: 'en',
        to: ['es', 'pt'],
        namespace: 'alpha',
        config,
        engine: new PartialEngine(['es']),
        logger: a.log,
      }),
      translateJson({
        sourceFlat: { b1: 'one', b2: 'two' },
        from: 'en',
        to: ['es', 'pt'],
        namespace: 'beta',
        config,
        engine: new PartialEngine(['es']),
        logger: b.log,
      }),
    ]);

    const messagesA = a.entries.map((e) => e.message);
    const messagesB = b.entries.map((e) => e.message);
    assert.ok(messagesA.length > 0 && messagesB.length > 0);
    assert.ok(
      messagesA.every((m) => !m.includes('[beta') && !m.includes('all 2 key(s)')),
      `A saw: ${messagesA.join(' | ')}`,
    );
    assert.ok(
      messagesB.every((m) => !m.includes('[alpha') && !m.includes('all 1 key(s)')),
      `B saw: ${messagesB.join(' | ')}`,
    );
    assert.ok(
      messagesA.some((m) => m.includes('all 1 key(s)')),
      'A should have its own engine warning',
    );
    assert.ok(
      messagesB.some((m) => m.includes('all 2 key(s)')),
      'B should have its own engine warning',
    );
  });
});

describe('an engine and the logger', () => {
  const plain = (): EngineAdapter => ({
    async translateChunk(chunk: TranslationChunk, targetLocales: string[]) {
      return Object.fromEntries(
        targetLocales.map((l) => [l, { keys: Object.fromEntries(Object.keys(chunk.keys).map((k) => [k, 'x'])) }]),
      );
    },
  });

  test('an engine without setLogger runs, and the run still logs', async () => {
    const given = collector();

    const { translations } = await translateJson({
      sourceFlat: { a: 'Hello' },
      from: 'en',
      to: ['es'],
      namespace: 'quiet',
      config,
      engine: plain(),
      logger: given.log,
    });

    assert.deepEqual(translations, { es: { a: 'x' } });
    assert.ok(given.at('info').length > 0);
  });

  test('an engine with setLogger is handed the run log, so what it says lands in stats.warnings', async () => {
    const given = collector();
    let handed: LogFn | undefined;
    const engine: EngineAdapter = {
      ...plain(),
      setLogger(log) {
        handed = log;
      },
    };

    const { stats } = await translateJson({
      sourceFlat: { a: 'Hello' },
      from: 'en',
      to: ['es'],
      namespace: 'quiet',
      config,
      engine,
      logger: given.log,
    });
    assert.ok(handed, 'setLogger was never called');
    handed('warn', 'said by the engine');

    assert.ok(stats.warnings.includes('said by the engine'));
    assert.ok(given.at('warn').includes('said by the engine'));
  });
});
