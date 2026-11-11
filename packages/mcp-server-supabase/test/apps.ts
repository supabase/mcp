import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SURFACE_NAMES,
  surfaceAssetFiles,
  type SurfaceName,
} from '../src/apps/contracts.js';

export { SURFACE_NAMES };

/** A surface build's script, tagged so tests can tell revisions apart. */
export function surfaceScript(surface: SurfaceName, revision = 1) {
  return `console.log("${surface} r${revision}")`;
}

export function surfaceStyle(surface: SurfaceName, revision = 1) {
  return `/* ${surface} r${revision} */ body { margin: 0 }`;
}

/**
 * A stand-in for `apps/mcp-apps/dist/v1`: one script and one stylesheet per
 * surface, shaped like the monorepo build output.
 */
export async function createAppsDir() {
  const dir = await mkdtemp(join(tmpdir(), 'supabase-mcp-apps-'));
  async function build(revision = 1, surfaces = SURFACE_NAMES) {
    for (const surface of surfaces) {
      const files = surfaceAssetFiles(surface);
      await writeFile(
        join(dir, files.script),
        surfaceScript(surface, revision)
      );
      await writeFile(join(dir, files.style), surfaceStyle(surface, revision));
    }
  }
  await build();
  return {
    dir,
    build,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
