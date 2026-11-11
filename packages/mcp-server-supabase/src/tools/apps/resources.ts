import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Resource } from '@supabase/mcp-utils';

import {
  renderSurfaceDocument,
  SURFACE_ASSETS_VERSION,
  SURFACE_MIME_TYPE,
  SURFACE_NAMES,
  surfaceAssetFiles,
  surfaceResources,
  type SurfaceAsset,
  type SurfaceName,
} from '../../apps/contracts.js';

/**
 * Where surface assets come from. The surface build (`apps/mcp-apps` in the
 * Supabase monorepo) publishes one script and one stylesheet per surface.
 *
 * - `{ url }` links a published build, e.g.
 *   `https://supabase.com/mcp-apps/v1`. Hosts load the files from that origin,
 *   which the resource declares in its CSP `resourceDomains`.
 * - `{ url, inline: true }` fetches the published build on the server and
 *   inlines it, for hosts that block external assets. Fetched files are cached
 *   for `cacheSeconds`.
 * - `{ dir }` inlines a local build directory, re-read on every resource read
 *   so rebuilds are served without a restart. For development.
 */
export type AppAssets =
  | { url: string; inline?: boolean; cacheSeconds?: number }
  | { dir: string };

export type AppsOptions = {
  assets: AppAssets;
  /**
   * Which clients get the app tools. `capable` (default) leaves them out for
   * clients known not to support MCP Apps: those whose capabilities lack the
   * `io.modelcontextprotocol/ui` extension. A client whose capabilities are
   * unknown, e.g. on a stateless 2025-era request without
   * `SupabaseMcpServerOptions.clientCapabilities`, still gets them.
   */
  clients?: 'capable' | 'all';
  /** Deep link base used for composer mention links and the bootstrap payload. */
  appLinkBase?: string;
};

export const APPS_BUILD_COMMAND = 'pnpm --filter mcp-apps build';

/** Surface names, spelled out so published declarations stay readable. */
export type AppSurface = SurfaceName;

function trimSlash(url: string) {
  return url.replace(/\/+$/, '');
}

export function assertValidAssetsUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid MCP Apps assets URL: ${url}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))
    throw new Error('MCP Apps assets must be served over HTTPS');
  if (parsed.search || parsed.hash)
    throw new Error('MCP Apps assets URL must not have a query or fragment');
}

function createAssetLoader(assets: AppAssets) {
  if ('dir' in assets) {
    const { dir } = assets;
    return async (file: string) => {
      try {
        return await readFile(join(dir, file), 'utf8');
      } catch {
        throw new Error(
          `Supabase MCP Apps are not built in ${dir}: missing ${file}. Build them in the Supabase monorepo with \`${APPS_BUILD_COMMAND}\` and pass the ${SURFACE_ASSETS_VERSION} build directory.`
        );
      }
    };
  }

  const base = trimSlash(assets.url);
  const ttl = (assets.cacheSeconds ?? 300) * 1000;
  const cache = new Map<string, { at: number; text: Promise<string> }>();
  return (file: string) => {
    const hit = cache.get(file);
    if (hit && Date.now() - hit.at < ttl) return hit.text;
    const text = fetch(`${base}/${file}`).then(async (response) => {
      if (!response.ok)
        throw new Error(
          `Failed to load MCP Apps asset ${file}: HTTP ${response.status}`
        );
      return response.text();
    });
    // A failed fetch is retried on the next read, not cached.
    text.catch(() => {
      if (cache.get(file)?.text === text) cache.delete(file);
    });
    cache.set(file, { at: Date.now(), text });
    return text;
  };
}

/** One `ui://` resource per surface. */
export function getAppResources(options: AppsOptions): Resource[] {
  const { assets } = options;
  const linked = 'url' in assets && !assets.inline;
  if ('url' in assets) assertValidAssetsUrl(assets.url);
  const load = linked ? undefined : createAssetLoader(assets);
  const base = 'url' in assets ? trimSlash(assets.url) : undefined;
  const resourceDomains = linked ? [new URL(base!).origin] : [];

  async function asset(file: string): Promise<SurfaceAsset> {
    return load ? { inline: await load(file) } : { url: `${base}/${file}` };
  }

  return SURFACE_NAMES.map((surface) => {
    const { uri, name, description, displayModes, preferredDisplayMode } =
      surfaceResources[surface];
    const files = surfaceAssetFiles(surface);
    return {
      uri,
      name,
      description,
      mimeType: SURFACE_MIME_TYPE,
      async read() {
        const [script, style] = await Promise.all([
          asset(files.script),
          asset(files.style),
        ]);
        return {
          uri,
          mimeType: SURFACE_MIME_TYPE,
          text: renderSurfaceDocument({ surface, script, style }),
          // Hosts read `_meta.ui` from the content item, not the list entry.
          _meta: {
            ui: {
              // Surfaces never fetch directly: every read goes through a tool call.
              csp: { connectDomains: [], resourceDomains },
              prefersBorder: false,
              preferredDisplayMode,
            },
            'openai/ui': {
              preferredDisplayMode,
              availableDisplayModes: [...displayModes],
            },
          },
        };
      },
    };
  });
}
