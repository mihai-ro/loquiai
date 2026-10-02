import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConcurrencyPool } from './concurrency-pool.js';
import { LoquiError } from './errors.js';

describe('ConcurrencyPool — AIMD', () => {
  test('runs all tasks and respects the initial window', async () => {
    const pool = new ConcurrencyPool(2);
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 6 }, () => async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise<void>((r) => setTimeout(r, 5));
      current--;
    });

    await pool.run(tasks);
    assert.ok(maxConcurrent <= 2, `maxConcurrent was ${maxConcurrent}, expected <= 2`);
  });

  test('onRateLimited halves the window (floor 1)', () => {
    const pool = new ConcurrencyPool(8);
    pool.onRateLimited();
    assert.equal(pool.current, 4);
    pool.onRateLimited();
    assert.equal(pool.current, 2);
    pool.onRateLimited();
    assert.equal(pool.current, 1);
    pool.onRateLimited();
    assert.equal(pool.current, 1); // floor at 1
  });

  test('onSuccess ramps up after N consecutive successes', () => {
    const pool = new ConcurrencyPool(8);
    pool.onRateLimited(); // window = 4
    for (let i = 0; i < 10; i++) pool.onSuccess();
    assert.equal(pool.current, 5);
    for (let i = 0; i < 10; i++) pool.onSuccess();
    assert.equal(pool.current, 6);
  });

  test('window never exceeds the configured max', () => {
    const pool = new ConcurrencyPool(4);
    for (let i = 0; i < 200; i++) pool.onSuccess();
    assert.equal(pool.current, 4);
  });

  test('run respects window shrink mid-flight', async () => {
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const pool = new ConcurrencyPool(4);
    let inflight = 0;
    let maxAfterShrink = 0;
    let shrunk = false;
    const resolvers: Array<() => void> = [];

    const makeTask = () => () =>
      new Promise<void>((resolve) => {
        inflight++;
        if (shrunk) maxAfterShrink = Math.max(maxAfterShrink, inflight);
        resolvers.push(() => {
          inflight--;
          resolve();
        });
      });

    const tasks = Array.from({ length: 8 }, makeTask);
    const runPromise = pool.run(tasks);

    // pool dispatches 4 synchronously before hitting the first await
    assert.equal(inflight, 4);

    shrunk = true;
    pool.onRateLimited(); // window 4 → 2

    // drain all 8 tasks one at a time; resolvers array stays populated as pool dispatches
    for (let i = 0; i < 8; i++) {
      const resolve = resolvers.shift();
      assert.ok(resolve, `expected resolver at step ${i}`);
      resolve();
      await tick();
    }
    await runPromise;

    assert.ok(maxAfterShrink <= 2, `max concurrency after rate limit: ${maxAfterShrink}, expected <= 2`);
  });

  test('run throws AggregateError when tasks fail', async () => {
    const pool = new ConcurrencyPool(2);
    const boom = new Error('task exploded');
    const tasks = [
      async () => {
        throw boom;
      },
      async () => {},
      async () => {
        throw new Error('another failure');
      },
    ];

    await assert.rejects(
      () => pool.run(tasks),
      (err: unknown) => {
        assert.ok(err instanceof AggregateError);
        assert.equal(err.errors.length, 2);
        assert.equal(err.errors[0], boom);
        return true;
      },
    );
  });

  test('run does not call onSuccess for failed tasks', async () => {
    const pool = new ConcurrencyPool(4);
    const successCount = { value: 0 };
    const origOnSuccess = pool.onSuccess.bind(pool);
    pool.onSuccess = () => {
      successCount.value++;
      origOnSuccess();
    };

    const tasks = [
      async () => {},
      async () => {
        throw new Error('fail');
      },
      async () => {},
    ];
    await assert.rejects(() => pool.run(tasks));
    assert.equal(successCount.value, 2);
  });
});

describe('ConcurrencyPool — a refused key', () => {
  test('ConcurrencyPool stops starting tasks once one rejects with AUTH, and still throws the aggregate', async () => {
    const pool = new ConcurrencyPool(2);
    let started = 0;
    const tasks = Array.from({ length: 10 }, () => async () => {
      started++;
      throw new LoquiError('AUTH', 'invalid key');
    });

    await assert.rejects(
      pool.run(tasks),
      (err: unknown) => err instanceof AggregateError && err.errors.every((e) => e instanceof LoquiError),
    );
    assert.ok(started <= 2, `${started} tasks started at window 2`);
  });
});
