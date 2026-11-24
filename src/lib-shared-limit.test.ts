import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { translate } from './lib.js';

let tmpDir: string;
const realFetch = globalThis.fetch;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loqui-limit-'));
  process.env.OPENAI_API_KEY = 'sk-test-limit';
});

after(() => {
  delete process.env.OPENAI_API_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A source whose keys do not fit one chunk, so a run has several requests to make. */
function source(name: string): string {
  const file = path.join(tmpDir, name);
  const doc = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`key${i}`, `A sentence to translate, number ${i}`]),
  );
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

describe('concurrent translate() calls on one engine', () => {
  test('never have more than `concurrency` fetches in flight between them', async () => {
    let inFlight = 0;
    let max = 0;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"es":{}}' }, finish_reason: 'stop' }] }));
    }) as typeof fetch;

    const runs = ['a.json', 'b.json', 'c.json'].map((name) =>
      translate({
        input: source(name),
        from: 'en',
        to: ['es'],
        config: { engine: 'openai', concurrency: 2, splitToken: 500 },
      }),
    );
    await Promise.allSettled(runs);

    assert.ok(calls >= 6, `the three runs made ${calls} requests`);
    assert.equal(max, 2);
  });
});
