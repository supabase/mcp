/** Default time-to-live for {@linkcode createTtlCache}: five minutes. */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export type TtlCacheOptions<T> = {
  /**
   * Loads a fresh value. Called on the first `get()`, once the cached value
   * is older than `ttlMs`, and after `invalidate()`.
   */
  load: () => Promise<T>;
  /**
   * How long a loaded value is served before the next `get()` re-loads it.
   * Defaults to {@linkcode DEFAULT_CACHE_TTL_MS}.
   */
  ttlMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
};

export type TtlCache<T> = {
  /** The time-to-live this cache was configured with, in milliseconds. */
  readonly ttlMs: number;
  /**
   * Returns the cached value, re-loading it only when the cached one is older
   * than `ttlMs`. Concurrent calls during a load share the same in-flight
   * promise instead of triggering duplicate loads. A failed load is not
   * cached: the next call retries.
   */
  get(): Promise<T>;
  /** Drops the cached value so the next `get()` call re-loads. */
  invalidate(): void;
};

/**
 * Wraps an async loader with an in-memory, time-to-live cache and in-flight
 * de-duplication.
 */
export function createTtlCache<T>(options: TtlCacheOptions<T>): TtlCache<T> {
  const { load, ttlMs = DEFAULT_CACHE_TTL_MS, now = Date.now } = options;

  if (!(ttlMs >= 0)) {
    throw new RangeError(`ttlMs must be a non-negative number, got ${ttlMs}`);
  }

  let cached: { value: T; expiresAt: number } | undefined;
  let inflight: Promise<T> | undefined;

  async function refresh(): Promise<T> {
    const value = await load();
    cached = { value, expiresAt: now() + ttlMs };
    return value;
  }

  return {
    ttlMs,
    async get() {
      if (cached && cached.expiresAt > now()) {
        return cached.value;
      }

      if (!inflight) {
        inflight = refresh().finally(() => {
          inflight = undefined;
        });
      }

      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
