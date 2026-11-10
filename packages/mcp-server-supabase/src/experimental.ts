import type { SupabaseExtensionFactory } from './server.js';

export type ExperimentalExtensionOptions = {
  /** Enable the MCP Apps extension (`--experimental-apps` / `experimental_apps=true`). */
  apps?: boolean;
};

/**
 * Maps experimental flags to extension factories. Both the CLI and the local
 * HTTP entry go through this so other hosts can reuse it.
 */
export async function loadExperimentalExtensions(
  opts: ExperimentalExtensionOptions
): Promise<SupabaseExtensionFactory[]> {
  const extensions: SupabaseExtensionFactory[] = [];

  if (opts.apps) {
    // Step 4 will dynamically `import('@supabase/mcp-apps-supabase')` here and
    // push its factory. Until then the flag is accepted but adds nothing.
  }

  return extensions;
}
