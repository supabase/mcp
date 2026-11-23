/**
 * Gating for MCP Apps (https://modelcontextprotocol.io/extensions/apps/overview).
 * The views are registered in `resources/app-resources.ts`.
 */
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import {
  CLIENT_CAPABILITIES_META_KEY,
  isSpecType,
  type ServerContext,
} from '@modelcontextprotocol/server';

/**
 * Whether this request gets MCP Apps: the flag is on and the client advertises
 * the extension.
 */
export function appsEnabled(
  experimentalApps: boolean,
  ctx: ServerContext | undefined
): boolean {
  if (!experimentalApps) return false;

  // Only modern-era requests carry capabilities in their envelope.
  const envelope = ctx?.mcpReq.envelope;
  if (!envelope || !(CLIENT_CAPABILITIES_META_KEY in envelope)) return false;

  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY];
  if (!isSpecType.ClientCapabilities(capabilities)) return false;

  const mimeTypes = capabilities.extensions?.[EXTENSION_ID]?.mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(RESOURCE_MIME_TYPE);
}

/** Declares MCP Apps support in `capabilities.extensions`. */
export const APPS_EXTENSIONS = {
  [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
};

/** Tool result `_meta` key with the dashboard base URL the server links to. */
export const DASHBOARD_URL_META_KEY = 'supabase.com/dashboardUrl';

/**
 * Tool result `_meta` key with what a view shows, kept out of the text the
 * model reads: `show_*` tools send their rows here.
 */
export const VIEW_DATA_META_KEY = 'supabase.com/view';

/**
 * Tools that exist only to show the user a view. Clients that can't render
 * views don't list them: other tools already give the model the same data.
 */
export const VIEW_TOOLS: ReadonlySet<string> = new Set([
  'show_query',
  'show_row',
  'show_logs',
]);
