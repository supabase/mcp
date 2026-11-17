/**
 * MCP Apps views (https://modelcontextprotocol.io/extensions/apps/overview)
 * that hosts (Claude, ChatGPT, etc.) render for tool results.
 *
 * Each view is built from `packages/mcp-ui` into a self-contained HTML file
 * and inlined into this bundle as a string at build time, so serving one is a
 * static read. Tools link to a view with `_meta: { ui: { resourceUri } }`.
 */
import type { McpUiResourceMeta } from '@modelcontextprotocol/ext-apps';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { resource, type Resource } from '@supabase/mcp-utils';

const VIEW_META: { ui: McpUiResourceMeta } = {
  ui: {
    // Views are fully inlined and make no network requests.
    csp: { connectDomains: [], resourceDomains: [] },
    // Views blend into the conversation instead of sitting in a host frame.
    prefersBorder: false,
  },
};

function appResource(
  uri: string,
  name: string,
  description: string,
  html: string
): Resource {
  return resource(uri, {
    name,
    description,
    mimeType: RESOURCE_MIME_TYPE,
    _meta: VIEW_META,
    // Hosts read `_meta` from the content first, so send it here too.
    read: async () => ({
      uri,
      mimeType: RESOURCE_MIME_TYPE,
      text: html,
      _meta: VIEW_META,
    }),
  });
}

export function getAppResources(): Resource[] {
  return [];
}
