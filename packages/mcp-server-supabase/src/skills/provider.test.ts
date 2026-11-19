import { describe, expect, it } from 'vitest';
import { createSkillsProvider } from './provider.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch stub that counts calls to the discovery index URL. */
function createCountingFetch(): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonResponse({ skills: [] });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('createSkillsProvider', () => {
  it('fetches once and serves the cached manifest within the ttl', async () => {
    let now = 0;
    const { fetchImpl, calls } = createCountingFetch();

    const provider = createSkillsProvider({
      ttlMs: 1000,
      now: () => now,
      fetchImpl,
    });

    const first = await provider.getManifest();
    now += 500;
    const second = await provider.getManifest();

    expect(first).toBe(second);
    expect(calls()).toBe(1);
  });

  it('re-fetches once the ttl has elapsed', async () => {
    let now = 0;
    const { fetchImpl, calls } = createCountingFetch();

    const provider = createSkillsProvider({
      ttlMs: 1000,
      now: () => now,
      fetchImpl,
    });

    await provider.getManifest();
    now += 999;
    await provider.getManifest();
    expect(calls()).toBe(1);

    now += 2;
    const manifest = await provider.getManifest();
    expect(calls()).toBe(2);
    expect(manifest.skills).toEqual([]);
  });

  it('invalidate() forces the next call to re-fetch even within the ttl', async () => {
    const { fetchImpl, calls } = createCountingFetch();
    const provider = createSkillsProvider({ ttlMs: 60_000, fetchImpl });

    await provider.getManifest();
    provider.invalidate();
    await provider.getManifest();

    expect(calls()).toBe(2);
  });

  it('shares a single in-flight fetch across concurrent callers', async () => {
    let calls = 0;
    let resolveFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });

    const fetchImpl = (async () => {
      calls++;
      await gate;
      return jsonResponse({ skills: [] });
    }) as typeof fetch;

    const provider = createSkillsProvider({ ttlMs: 60_000, fetchImpl });

    const a = provider.getManifest();
    const b = provider.getManifest();
    resolveFetch?.();
    await Promise.all([a, b]);

    expect(calls).toBe(1);
  });

  it('retries after a failed fetch instead of caching the rejection', async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error('network error');
      }
      return jsonResponse({ skills: [] });
    }) as typeof fetch;

    const provider = createSkillsProvider({ ttlMs: 60_000, fetchImpl });

    await expect(provider.getManifest()).rejects.toThrow('network error');
    await expect(provider.getManifest()).resolves.toEqual(
      expect.objectContaining({ skills: [] })
    );
    expect(attempt).toBe(2);
  });
});
