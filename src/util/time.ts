export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Random integer in [min, max]. */
export function randInt(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function jitterDelay(minMs: number, maxMs: number): Promise<void> {
  return sleep(randInt(minMs, maxMs));
}

/**
 * Enforces a minimum interval between calls (e.g. AdsPower's 1 req/sec limit).
 * Serialises callers through a shared promise chain.
 */
export class RateLimiter {
  private last = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.last);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    });
    // Keep the chain alive regardless of fn() success.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run.then(fn);
  }
}
