/**
 * MCP Apps (https://modelcontextprotocol.io/extensions/apps/overview): UI
 * views that MCP Apps hosts (Claude, ChatGPT, etc.) render for tool results.
 *
 * Each view is built from `packages/mcp-ui` into a self-contained HTML file
 * and inlined into this bundle as a string at build time, so serving one is a
 * static read. Tools link to a view with `_meta: { ui: { resourceUri } }`.
 */
import type { McpUiResourceMeta } from '@modelcontextprotocol/ext-apps';
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import type { Resource } from '@supabase/mcp-utils';
import listProjectsHtml from '@supabase/mcp-ui/list-projects.html';
import listTablesHtml from '@supabase/mcp-ui/list-tables.html';

export const LIST_PROJECTS_UI_URI = 'ui://supabase/list-projects';
export const LIST_TABLES_UI_URI = 'ui://supabase/list-tables';

/** Declares MCP Apps support in `capabilities.extensions`. */
export const APPS_EXTENSIONS = {
  [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
};

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
  return {
    uri,
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
  };
}

export function getAppResources(): Resource[] {
  return [
    appResource(
      LIST_PROJECTS_UI_URI,
      'List projects view',
      'Interactive list of Supabase projects for the list_projects tool.',
      listProjectsHtml
    ),
    appResource(
      LIST_TABLES_UI_URI,
      'List tables view',
      'Interactive list of database tables for the list_tables tool.',
      listTablesHtml
    ),
  ];
}
