import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from './config.js';
import { LoquiError } from './errors.js';
import { CONFIG_DEFAULTS } from './types.js';

function assertInvalidConfig(fn: () => unknown, pattern?: RegExp): void {
  try {
    fn();
    assert.fail('Expected LoquiError(INVALID_CONFIG) but no error thrown');
  } catch (err) {
    assert.ok(err instanceof LoquiError, `expected LoquiError, got ${(err as Error)?.constructor?.name}`);
    assert.equal((err as LoquiError).code, 'INVALID_CONFIG');
    if (pattern) assert.match((err as LoquiError).message, pattern);
  }
}

let tmpDir: string;
let counter = 0;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-config-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDir(): string {
  return fs.mkdtempSync(path.join(tmpDir, `cfg${counter++}-`));
}

function writeConfig(dir: string, data: Record<string, unknown>, filename = '.loqui.json'): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

describe('loadConfig — file discovery', () => {
  test('returns defaults when no config file found in directory', () => {
    const config = loadConfig(makeDir());
    assert.deepEqual(config, CONFIG_DEFAULTS);
  });

  test('loads config from directory containing .loqui.json', () => {
    const dir = makeDir();
    writeConfig(dir, { engine: 'openai', model: 'gpt-4o' });
    const config = loadConfig(dir);
    assert.equal(config.engine, 'openai');
    assert.equal(config.model, 'gpt-4o');
  });

  test('loads config from explicit file path', () => {
    const dir = makeDir();
    const filePath = writeConfig(dir, { engine: 'anthropic' }, 'custom.json');
    const config = loadConfig(filePath);
    assert.equal(config.engine, 'anthropic');
  });

  test('merges file values with defaults', () => {
    const dir = makeDir();
    writeConfig(dir, { engine: 'openai' });
    const config = loadConfig(dir);
    assert.equal(config.engine, 'openai');
    assert.equal(config.concurrency, CONFIG_DEFAULTS.concurrency);
    assert.equal(config.temperature, CONFIG_DEFAULTS.temperature);
  });

  test('$schema key is allowed', () => {
    const dir = makeDir();
    writeConfig(dir, { $schema: './node_modules/@mihairo/loqui/loqui.schema.json', engine: 'gemini' });
    assert.doesNotThrow(() => loadConfig(dir));
  });
});

describe('loadConfig — JSON parse errors', () => {
  test('throws LoquiError INVALID_CONFIG on invalid JSON', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, '.loqui.json'), '{not valid json}');
    assertInvalidConfig(() => loadConfig(dir), /Failed to parse/);
  });
});

describe('loadConfig — unknown key detection', () => {
  test('throws on unknown top-level key', () => {
    const dir = makeDir();
    writeConfig(dir, { typo: 'value' });
    assert.throws(() => loadConfig(dir), /Unknown config key/);
  });

  test('error message names the offending key', () => {
    const dir = makeDir();
    writeConfig(dir, { engien: 'gemini' });
    assert.throws(() => loadConfig(dir), /'engien'/);
  });

  test('throws on unknown key inside prompts', () => {
    const dir = makeDir();
    writeConfig(dir, { prompts: { system: 'hi', badKey: 'x' } });
    assert.throws(() => loadConfig(dir), /Unknown key.*prompts/);
  });
});

describe('loadConfig — engine validation', () => {
  test('throws LoquiError INVALID_CONFIG on invalid engine value', () => {
    const dir = makeDir();
    writeConfig(dir, { engine: 'unknown-engine' });
    assertInvalidConfig(() => loadConfig(dir), /'engine' must be one of/);
  });
});

describe('loadConfig — model validation', () => {
  test('throws on empty model string', () => {
    const dir = makeDir();
    writeConfig(dir, { engine: 'openai', model: '' });
    assert.throws(() => loadConfig(dir), /'model' must be a non-empty string/);
  });

  test('throws on non-string model', () => {
    const dir = makeDir();
    writeConfig(dir, { engine: 'openai', model: 42 });
    assert.throws(() => loadConfig(dir), /'model' must be a non-empty string/);
  });
});

describe('loadConfig — locale validation', () => {
  test('throws on non-string from', () => {
    const dir = makeDir();
    writeConfig(dir, { from: 42 });
    assert.throws(() => loadConfig(dir), /'from' must be a non-empty string/);
  });

  test('throws on empty from', () => {
    const dir = makeDir();
    writeConfig(dir, { from: '' });
    assert.throws(() => loadConfig(dir), /'from' must be a non-empty string/);
  });

  test('throws when to contains non-string item', () => {
    const dir = makeDir();
    writeConfig(dir, { to: ['fr', 42] });
    assert.throws(() => loadConfig(dir), /'to' must be an array/);
  });

  test('throws when to contains empty string', () => {
    const dir = makeDir();
    writeConfig(dir, { to: ['fr', ''] });
    assert.throws(() => loadConfig(dir), /'to' must be an array/);
  });

  test('accepts valid from and to', () => {
    const dir = makeDir();
    writeConfig(dir, { from: 'en', to: ['fr', 'de'] });
    const config = loadConfig(dir);
    assert.equal(config.from, 'en');
    assert.deepEqual(config.to, ['fr', 'de']);
  });
});

describe('loadConfig — numeric range validation', () => {
  test('throws on temperature out of range', () => {
    const dir = makeDir();
    writeConfig(dir, { temperature: 5 });
    assert.throws(() => loadConfig(dir), /'temperature' must be/);
  });

  test('throws on topP out of range', () => {
    const dir = makeDir();
    writeConfig(dir, { topP: 2 });
    assert.throws(() => loadConfig(dir), /'topP' must be/);
  });

  test('throws on invalid concurrency', () => {
    const dir = makeDir();
    writeConfig(dir, { concurrency: 0 });
    assert.throws(() => loadConfig(dir), /'concurrency' must be/);
  });

  test('throws on invalid splitToken', () => {
    const dir = makeDir();
    writeConfig(dir, { splitToken: 100 });
    assert.throws(() => loadConfig(dir), /'splitToken' must be/);
  });
});

describe('loadConfig — optional field validation', () => {
  test('accepts valid context string', () => {
    const dir = makeDir();
    writeConfig(dir, { context: 'a scheduling app' });
    assert.equal(loadConfig(dir).context, 'a scheduling app');
  });

  test('accepts valid prompts object', () => {
    const dir = makeDir();
    writeConfig(dir, { prompts: { system: 'sys', user: 'usr' } });
    const config = loadConfig(dir);
    assert.equal(config.prompts?.system, 'sys');
    assert.equal(config.prompts?.user, 'usr');
  });

  test('throws when prompts is not an object', () => {
    const dir = makeDir();
    writeConfig(dir, { prompts: 'bad' });
    assert.throws(() => loadConfig(dir), /'prompts' must be an object/);
  });

  test('throws when prompts.system is not a string', () => {
    const dir = makeDir();
    writeConfig(dir, { prompts: { system: 42 } });
    assert.throws(() => loadConfig(dir), /'prompts.system' must be a string/);
  });

  test('accepts valid placeholderPatterns', () => {
    const dir = makeDir();
    writeConfig(dir, { placeholderPatterns: ['%\\{[^}]+\\}'] });
    assert.deepEqual(loadConfig(dir).placeholderPatterns, ['%\\{[^}]+\\}']);
  });

  test('throws on invalid regex in placeholderPatterns', () => {
    const dir = makeDir();
    writeConfig(dir, { placeholderPatterns: ['[invalid('] });
    assert.throws(() => loadConfig(dir), /invalid regex/);
  });

  test('throws when placeholderPatterns item is not a string', () => {
    const dir = makeDir();
    writeConfig(dir, { placeholderPatterns: [42] });
    assert.throws(() => loadConfig(dir), /placeholderPatterns.*items must all be strings/);
  });

  test('accepts valid timeout', () => {
    const dir = makeDir();
    writeConfig(dir, { timeout: 30000 });
    assert.equal(loadConfig(dir).timeout, 30000);
  });

  test('throws on negative timeout', () => {
    const dir = makeDir();
    writeConfig(dir, { timeout: -1 });
    assert.throws(() => loadConfig(dir), /'timeout' must be/);
  });

  test('throws on non-finite timeout', () => {
    const dir = makeDir();
    writeConfig(dir, { timeout: null });
    assert.throws(() => loadConfig(dir), /'timeout' must be/);
  });
});
