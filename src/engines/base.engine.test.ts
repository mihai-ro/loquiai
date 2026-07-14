import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONFIG_DEFAULTS, type LoquiConfig, type TranslationChunk, type TranslationResult } from '../types.js';
import { BaseEngine } from './base.engine.js';

type CallArgs = { systemPrompt: string; userPrompt: string; expectedKeys: string[]; targetLocales: string[] };

class TestableEngine extends BaseEngine {
  lastCall: CallArgs | null = null;

  constructor(config?: Partial<LoquiConfig>) {
    super({ ...CONFIG_DEFAULTS, ...config }, 'test-key');
  }

  parseResponseForTest(raw: string, expectedKeys: string[], targetLocales: string[]) {
    return this.parseResponse(raw, expectedKeys, targetLocales);
  }

  protected async makeCall(
    systemPrompt: string,
    userPrompt: string,
    expectedKeys: string[],
    targetLocales: string[],
  ): Promise<Record<string, TranslationResult>> {
    this.lastCall = { systemPrompt, userPrompt, expectedKeys, targetLocales };
    return Object.fromEntries(
      targetLocales.map((l) => [l, { keys: Object.fromEntries(expectedKeys.map((k) => [k, 'T'])) }]),
    );
  }
}

describe('parseResponse', () => {
  test('valid response — returns correct locale and key structure', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest(
      '{"fr":{"greeting":"Bonjour","farewell":"Au revoir"},"de":{"greeting":"Hallo","farewell":"Auf Wiedersehen"}}',
      ['greeting', 'farewell'],
      ['fr', 'de'],
    );

    assert.equal(result.fr.keys.greeting, 'Bonjour');
    assert.equal(result.fr.keys.farewell, 'Au revoir');
    assert.equal(result.de.keys.greeting, 'Hallo');
    assert.equal(result.de.keys.farewell, 'Auf Wiedersehen');
  });

  test('missing locale in response — fills all keys with empty strings', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest('{"fr":{"greeting":"Bonjour"}}', ['greeting', 'farewell'], ['fr', 'de']);

    assert.equal(result.fr.keys.greeting, 'Bonjour');
    assert.equal(result.fr.keys.farewell, '');
    assert.equal(result.de.keys.greeting, '');
    assert.equal(result.de.keys.farewell, '');
  });

  test('non-string value for a key — uses empty string', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest(
      '{"fr":{"greeting":"Bonjour","count":42}}',
      ['greeting', 'count'],
      ['fr'],
    );

    assert.equal(result.fr.keys.greeting, 'Bonjour');
    assert.equal(result.fr.keys.count, '');
  });

  test('invalid JSON — throws with descriptive error', () => {
    const engine = new TestableEngine();
    assert.throws(
      () => engine.parseResponseForTest('not valid json at all', ['greeting'], ['fr']),
      (err: Error) => err.message.includes('Engine returned invalid JSON'),
    );
  });

  test('markdown-fenced JSON — strips fences before parsing', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest('```json\n{"fr":{"greeting":"Bonjour"}}\n```', ['greeting'], ['fr']);

    assert.equal(result.fr.keys.greeting, 'Bonjour');
  });

  test('triple-backtick fence without language tag — also stripped', () => {
    const engine = new TestableEngine();
    const result = engine.parseResponseForTest('```\n{"fr":{"greeting":"Salut"}}\n```', ['greeting'], ['fr']);

    assert.equal(result.fr.keys.greeting, 'Salut');
  });
});

describe('reviewChunk', () => {
  test('calls makeCall with review prompt containing source and initial translations', async () => {
    const engine = new TestableEngine();
    const chunk: TranslationChunk = { keys: { greeting: 'Hello' } };
    const initial: Record<string, TranslationResult> = { fr: { keys: { greeting: 'Bonjour' } } };

    await engine.reviewChunk(chunk, initial, ['fr'], 'en', 'test');

    const args = engine.lastCall;
    if (!args) throw new Error('makeCall must have been called');
    assert.ok(args.userPrompt.includes('Hello'), 'review prompt must include source text');
    assert.ok(args.userPrompt.includes('Bonjour'), 'review prompt must include initial translation');
    assert.ok(args.userPrompt.toLowerCase().includes('review'), 'review prompt must mention review');
    assert.deepEqual(args.expectedKeys, ['greeting']);
    assert.deepEqual(args.targetLocales, ['fr']);
  });

  test('translateChunk routes through makeCall', async () => {
    const engine = new TestableEngine();
    await engine.translateChunk({ keys: { k: 'v' } }, ['de'], 'en', 'ns');
    const args = engine.lastCall;
    if (!args) throw new Error('makeCall must have been called');
    assert.ok(args.userPrompt.includes('"k"'), 'user prompt must include source key');
  });

  test('glossaryBlock is appended to the system prompt when provided', async () => {
    const engine = new TestableEngine();
    const block = 'Use these exact term translations (glossary):\n- "Dashboard" -> es: Tablero';
    await engine.translateChunk({ keys: { k: 'v' } }, ['es'], 'en', 'ns', block);
    const args = engine.lastCall;
    if (!args) throw new Error('makeCall must have been called');
    assert.ok(args.systemPrompt.includes('Dashboard'), 'system prompt must include glossary block');
    assert.ok(args.systemPrompt.includes('Tablero'), 'system prompt must include locked term');
  });

  test('empty glossaryBlock does not modify system prompt', async () => {
    const engine = new TestableEngine();
    await engine.translateChunk({ keys: { k: 'v' } }, ['es'], 'en', 'ns');
    const noBlock = engine.lastCall?.systemPrompt ?? '';
    await engine.translateChunk({ keys: { k: 'v' } }, ['es'], 'en', 'ns', '');
    const emptyBlock = engine.lastCall?.systemPrompt ?? '';
    assert.equal(noBlock, emptyBlock);
  });

  test('review prompt differs from translate prompt for same chunk', async () => {
    const engine = new TestableEngine();
    const chunk: TranslationChunk = { keys: { msg: 'Hello' } };

    await engine.translateChunk(chunk, ['fr'], 'en', 'ns');
    const translatePrompt = engine.lastCall?.userPrompt ?? '';

    await engine.reviewChunk(chunk, { fr: { keys: { msg: 'Salut' } } }, ['fr'], 'en', 'ns');
    const reviewPrompt = engine.lastCall?.userPrompt ?? '';

    assert.notEqual(translatePrompt, reviewPrompt);
    assert.ok(reviewPrompt.includes('Salut'), 'review prompt must include initial translation value');
  });
});
