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
