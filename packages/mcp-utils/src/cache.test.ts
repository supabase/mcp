import { describe, expect, test } from 'vitest';
import { createTtlCache, DEFAULT_CACHE_TTL_MS } from './cache.js';

/** A loader that counts its calls and resolves to the call number. */
function createCountingLoad() {
  let calls = 0;
  const load = async () => {
    calls++;
    return calls;
  };
  return { load, calls: () => calls };
}

describe('createTtlCache', () => {
  test('defaults the ttl to five minutes and exposes it', () => {
    const cache = createTtlCache({ load: async () => 'value' });
    expect(cache.ttlMs).toBe(DEFAULT_CACHE_TTL_MS);
    expect(DEFAULT_CACHE_TTL_MS).toBe(300_000);

    expect(createTtlCache({ load: async () => 'value', ttlMs: 10 }).ttlMs).toBe(
      10
    );
  });

  test('rejects a negative or NaN ttl', () => {
    expect(() =>
      createTtlCache({ load: async () => 'value', ttlMs: -1 })
    ).toThrow(RangeError);
    expect(() =>
      createTtlCache({ load: async () => 'value', ttlMs: Number.NaN })
    ).toThrow(RangeError);
  });

  test('loads once and serves the cached value within the ttl', async () => {
    let now = 0;
    const { load, calls } = createCountingLoad();
    const cache = createTtlCache({ load, ttlMs: 1000, now: () => now });

    const first = await cache.get();
    now += 500;
    const second = await cache.get();

    expect(first).toBe(second);
    expect(calls()).toBe(1);
  });

  test('re-loads once the ttl has elapsed', async () => {
    let now = 0;
    const { load, calls } = createCountingLoad();
    const cache = createTtlCache({ load, ttlMs: 1000, now: () => now });

    await cache.get();
    now += 999;
    await cache.get();
    expect(calls()).toBe(1);

    now += 2;
    const value = await cache.get();
    expect(calls()).toBe(2);
    expect(value).toBe(2);
  });

  test('a ttl of zero re-loads on every call', async () => {
    const { load, calls } = createCountingLoad();
    const cache = createTtlCache({ load, ttlMs: 0 });

    await cache.get();
    await cache.get();

    expect(calls()).toBe(2);
  });

  test('invalidate() forces the next call to re-load even within the ttl', async () => {
    const { load, calls } = createCountingLoad();
    const cache = createTtlCache({ load, ttlMs: 60_000 });

    await cache.get();
    cache.invalidate();
    await cache.get();

    expect(calls()).toBe(2);
  });

  test('shares a single in-flight load across concurrent callers', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const cache = createTtlCache({
      ttlMs: 60_000,
      load: async () => {
        calls++;
        await gate;
        return 'value';
      },
    });

    const a = cache.get();
    const b = cache.get();
    release?.();

    await expect(Promise.all([a, b])).resolves.toEqual(['value', 'value']);
    expect(calls).toBe(1);
  });

  test('retries after a failed load instead of caching the rejection', async () => {
    let attempt = 0;
    const cache = createTtlCache({
      ttlMs: 60_000,
      load: async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error('network error');
        }
        return 'value';
      },
    });

    await expect(cache.get()).rejects.toThrow('network error');
    await expect(cache.get()).resolves.toBe('value');
    expect(attempt).toBe(2);

    // The successful value is now cached.
    await cache.get();
    expect(attempt).toBe(2);
  });
});
