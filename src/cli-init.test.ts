import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { type InputStream, runInit } from './cli-init.js';
import { LoquiError } from './errors.js';

let tmpDir: string;

before(async () => {
  // an empty directory as --config keeps these runs independent of any .loqui.json
  // that happens to sit in the working tree
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loqui-cli-'));
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

/** A stream that stands in for stdin, with the TTY flag the CLI branches on. */
function fakeStdin(chunks: string[], { isTTY = false }: { isTTY?: boolean } = {}): InputStream {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
  stream.isTTY = isTTY;
  queueMicrotask(() => {
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  return stream as InputStream;
}

/** Collects everything written to a stream, for asserting on wizard output. */
function sink(): NodeJS.WritableStream & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return Object.assign(stream, { text: () => chunks.join('') });
}

/** readline only sees a line while a question is pending, so a prompt looks like `…: ` or `…] `. */
const PROMPT = /[:\]] $/;

/**
 * Drives the interactive wizard: each answer is written only once its prompt has
 * been printed. Queueing them up front would lose every line but the first,
 * because readline discards input that arrives between questions.
 */
function wizardIO(answers: string[]): { input: InputStream; output: NodeJS.WritableStream; text: () => string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const queue = [...answers];
  const chunks: string[] = [];

  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk);
      chunks.push(text);
      if (PROMPT.test(text)) {
        const next = queue.shift();
        if (next !== undefined) setImmediate(() => input.write(next));
      }
      callback();
    },
  });

  return { input: input as InputStream, output, text: () => chunks.join('') };
}

describe('runInit', () => {
  test('refuses to run outside an interactive terminal', async () => {
    await assert.rejects(
      runInit({ input: fakeStdin([]), output: sink(), cwd: tmpDir }),
      (err: unknown) =>
        err instanceof LoquiError && err.code === 'INVALID_USAGE' && /interactive terminal/.test(err.message),
    );
  });

  test('writes a config from the answers given', async () => {
    const initDir = path.join(tmpDir, 'init-answers');
    fs.mkdirSync(initDir, { recursive: true });
    const io = wizardIO(['openai\n', 'gpt-5-mini\n', 'en\n', 'fr, de\n', 'a checkout flow\n']);

    await runInit({ input: io.input, output: io.output, cwd: initDir });

    const written = JSON.parse(fs.readFileSync(path.join(initDir, '.loqui.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(written.engine, 'openai');
    assert.equal(written.model, 'gpt-5-mini');
    assert.equal(written.from, 'en');
    assert.deepEqual(written.to, ['fr', 'de']);
    assert.equal(written.context, 'a checkout flow');
    assert.match(io.text(), /OPENAI_API_KEY/);
  });

  test('falls back to the defaults on empty answers and omits an empty context', async () => {
    const initDir = path.join(tmpDir, 'init-defaults');
    fs.mkdirSync(initDir, { recursive: true });

    const io = wizardIO(['\n', '\n', '\n', '\n', '\n']);
    await runInit({ input: io.input, output: io.output, cwd: initDir });

    const written = JSON.parse(fs.readFileSync(path.join(initDir, '.loqui.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(written.engine, 'gemini');
    assert.equal(written.from, 'en');
    assert.deepEqual(written.to, ['es', 'pt', 'de']);
    assert.ok(!('context' in written), 'an empty context should not be written');
  });

  test('rejects an unknown engine with INVALID_USAGE and releases the terminal first', async () => {
    const initDir = path.join(tmpDir, 'init-bad-engine');
    fs.mkdirSync(initDir, { recursive: true });
    const io = wizardIO(['klingon\n']);

    await assert.rejects(
      runInit({ input: io.input, output: io.output, cwd: initDir }),
      (err: unknown) => err instanceof LoquiError && err.code === 'INVALID_USAGE' && /Unknown engine/.test(err.message),
    );

    assert.ok(io.input.isPaused(), 'readline must be closed, or the process never exits');
  });

  test('leaves an existing config alone when the overwrite prompt is declined', async () => {
    const initDir = path.join(tmpDir, 'init-existing');
    fs.mkdirSync(initDir, { recursive: true });
    const configPath = path.join(initDir, '.loqui.json');
    fs.writeFileSync(configPath, '{"from":"keep-me"}', 'utf-8');
    const io = wizardIO(['n\n']);

    await runInit({ input: io.input, output: io.output, cwd: initDir });

    assert.equal(fs.readFileSync(configPath, 'utf-8'), '{"from":"keep-me"}');
    assert.match(io.text(), /Aborted/);
  });

  test('overwrites an existing config when the prompt is accepted', async () => {
    const initDir = path.join(tmpDir, 'init-overwrite');
    fs.mkdirSync(initDir, { recursive: true });
    const configPath = path.join(initDir, '.loqui.json');
    fs.writeFileSync(configPath, '{"from":"stale"}', 'utf-8');

    const io = wizardIO(['y\n', 'anthropic\n', '\n', 'en\n', 'nl\n', '\n']);
    await runInit({ input: io.input, output: io.output, cwd: initDir });

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    assert.equal(written.engine, 'anthropic');
    assert.deepEqual(written.to, ['nl']);
  });
});
