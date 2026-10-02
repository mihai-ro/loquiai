import { LoquiError } from './errors.js';

/**
 * Adaptive concurrency pool (AIMD — Additive Increase / Multiplicative Decrease).
 *
 * - Starts at the configured concurrency.
 * - Increases the active window by 1 after RAMP_AFTER consecutive successes.
 * - Halves the window (floor 1) on any rate-limit signal from the engine.
 *
 * The pool integrates with EngineAdapter.setRateLimitSignal?: engines call the
 * callback when they observe a 429, which feeds directly into onRateLimited().
 */
export class ConcurrencyPool {
  #window: number;
  readonly #maxWindow: number;
  #streak = 0;
  static readonly #RAMP_AFTER = 10;

  constructor(initial: number) {
    this.#window = Math.max(1, initial);
    this.#maxWindow = Math.max(1, initial);
  }

  get current(): number {
    return this.#window;
  }

  onRateLimited(): void {
    this.#window = Math.max(1, Math.ceil(this.#window / 2));
    this.#streak = 0;
  }

  onSuccess(): void {
    this.#streak++;
    if (this.#streak >= ConcurrencyPool.#RAMP_AFTER) {
      this.#window = Math.min(this.#maxWindow, this.#window + 1);
      this.#streak = 0;
    }
  }

  async run(tasks: (() => Promise<void>)[]): Promise<void> {
    const executing = new Set<Promise<void>>();
    const errors: unknown[] = [];
    // A rejected key fails every remaining request alike, so once one is refused there
    // is nothing to learn from sending the rest. Requests already in flight finish.
    let refused = false;

    for (const task of tasks) {
      if (refused) break;
      const p: Promise<void> = (async () => {
        try {
          await task();
          this.onSuccess();
        } catch (err) {
          errors.push(err);
          if (err instanceof LoquiError && err.code === 'AUTH') refused = true;
        }
      })().finally(() => {
        executing.delete(p);
      });
      executing.add(p);
      while (executing.size >= this.#window) await Promise.race(executing);
    }
    await Promise.all(executing);

    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} task(s) failed`);
    }
  }
}
