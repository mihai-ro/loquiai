import { LoquiError } from './errors.js';

/**
 * The requests in flight across every run that talks to one engine, so that concurrent
 * runs share a limit instead of each taking its own. The limit is the lowest `concurrency`
 * among the runs taking part: someone asked for no more than that, and a higher one
 * cannot override them. A run that finishes, or throws, stops counting, and the waiters
 * go on at the next lowest.
 */
export class SharedGate {
  #inFlight = 0;
  readonly #limits = new Set<{ limit: number }>();
  readonly #waiting: (() => void)[] = [];

  /** Takes part with `limit`; the returned lease is how this run asks for slots and leaves. */
  join(limit: number): GateLease {
    const member = { limit: Math.max(1, limit) };
    this.#limits.add(member);
    return {
      acquire: () => this.#acquire(),
      leave: () => {
        this.#limits.delete(member);
        this.#admit();
      },
    };
  }

  get #capacity(): number {
    return Math.min(...[...this.#limits].map(({ limit }) => limit));
  }

  async #acquire(): Promise<() => void> {
    if (this.#inFlight >= this.#capacity || this.#waiting.length > 0) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#inFlight++;
    }
    return () => {
      this.#inFlight--;
      this.#admit();
    };
  }

  /** Lets waiters in while there is room: a slot freed, or the lowest limit left. */
  #admit(): void {
    while (this.#waiting.length > 0 && this.#inFlight < this.#capacity) {
      this.#inFlight++;
      this.#waiting.shift()?.();
    }
  }
}

export interface GateLease {
  /** Resolves with the function that gives the slot back. */
  acquire(): Promise<() => void>;
  leave(): void;
}

const gates = new Map<string, SharedGate>();
const adapterGates = new WeakMap<object, SharedGate>();

/** The gate for one engine: by name for a built-in one, by identity for a caller's own adapter. */
export function gateFor(engine: string | object): SharedGate {
  if (typeof engine === 'string') {
    const found = gates.get(engine);
    if (found) return found;
    const gate = new SharedGate();
    gates.set(engine, gate);
    return gate;
  }
  const found = adapterGates.get(engine);
  if (found) return found;
  const gate = new SharedGate();
  adapterGates.set(engine, gate);
  return gate;
}

/**
 * Adaptive concurrency pool (AIMD — Additive Increase / Multiplicative Decrease).
 *
 * - Starts at the configured concurrency.
 * - Increases the active window by 1 after RAMP_AFTER consecutive successes.
 * - Halves the window (floor 1) on any rate-limit signal from the engine.
 *
 * Each run owns a pool and hands `onRateLimited` to the engine with every request:
 * engines call it when they observe a 429, which feeds directly into onRateLimited().
 */
export class ConcurrencyPool {
  #window: number;
  readonly #maxWindow: number;
  #streak = 0;
  static readonly #RAMP_AFTER = 10;

  readonly #gate?: SharedGate;

  /** `gate` is shared with the other runs on the same engine; without one the pool limits only itself. */
  constructor(initial: number, gate?: SharedGate) {
    this.#window = Math.max(1, initial);
    this.#maxWindow = Math.max(1, initial);
    this.#gate = gate;
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
    const lease = this.#gate?.join(this.#maxWindow);
    try {
      await this.#runTasks(tasks, lease);
    } finally {
      lease?.leave();
    }
  }

  async #runTasks(tasks: (() => Promise<void>)[], lease: GateLease | undefined): Promise<void> {
    const executing = new Set<Promise<void>>();
    const errors: unknown[] = [];
    // A rejected key fails every remaining request alike, so once one is refused there
    // is nothing to learn from sending the rest. Requests already in flight finish.
    let refused = false;

    for (const task of tasks) {
      if (refused) break;
      const p: Promise<void> = (async () => {
        // A slot is held for the task alone, and given back when it throws too.
        const release = lease ? await lease.acquire() : undefined;
        try {
          await task();
          this.onSuccess();
        } catch (err) {
          errors.push(err);
          if (err instanceof LoquiError && err.code === 'AUTH') refused = true;
        } finally {
          release?.();
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
