import { DEFAULT_SKILLS_TTL_MS } from './constants.js';
import {
  fetchSkillsManifest,
  type FetchSkillsManifestOptions,
  type SkillsManifest,
} from './manifest.js';

export type SkillsProviderOptions = FetchSkillsManifestOptions & {
  /**
   * How long a fetched manifest is served before the next call re-fetches
   * it. Defaults to {@linkcode DEFAULT_SKILLS_TTL_MS}.
   */
  ttlMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
};

export type SkillsProvider = {
  /**
   * Returns the current skills manifest, re-fetching (downloading, verifying,
   * and unpacking every skill archive) only when the cached one is older
   * than `ttlMs`. Concurrent calls during a refresh share the same in-flight
   * fetch instead of triggering duplicate downloads.
   */
  getManifest(): Promise<SkillsManifest>;
  /** Drops the cached manifest so the next `getManifest()` call re-fetches. */
  invalidate(): void;
};

/**
 * Wraps {@linkcode fetchSkillsManifest} with an in-memory, time-to-live
 * cache, so a busy server doesn't re-download and re-unpack every skill
 * archive on every `skills/list` / `skills/get` / `resources/read` call.
 */
export function createSkillsProvider(
  options: SkillsProviderOptions = {}
): SkillsProvider {
  const {
    ttlMs = DEFAULT_SKILLS_TTL_MS,
    now = Date.now,
    ...fetchOptions
  } = options;

  let cached: { manifest: SkillsManifest; expiresAt: number } | undefined;
  let inflight: Promise<SkillsManifest> | undefined;

  async function refresh(): Promise<SkillsManifest> {
    const manifest = await fetchSkillsManifest(fetchOptions);
    cached = { manifest, expiresAt: now() + ttlMs };
    return manifest;
  }

  return {
    async getManifest() {
      if (cached && cached.expiresAt > now()) {
        return cached.manifest;
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
