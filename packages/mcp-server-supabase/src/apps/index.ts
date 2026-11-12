/**
 * MCP Apps (https://modelcontextprotocol.io/extensions/apps/overview): UI
 * views that MCP Apps hosts (Claude, ChatGPT, etc.) render for tool results.
 *
 * Each view is built from `packages/mcp-ui` into a self-contained HTML file
 * and inlined into this bundle as a string at build time, so serving one is a
 * static read. Tools link to a view with `_meta: { ui: { resourceUri } }`.
 */
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { Resource } from '@supabase/mcp-utils';
import listProjectsHtml from '@supabase/mcp-ui/list-projects.html';
import listTablesHtml from '@supabase/mcp-ui/list-tables.html';

export const LIST_PROJECTS_UI_URI = 'ui://supabase/list-projects';
export const LIST_TABLES_UI_URI = 'ui://supabase/list-tables';

function appResource(uri: string, name: string, html: string): Resource {
  return {
    uri,
    name,
    mimeType: RESOURCE_MIME_TYPE,
    read: async () => ({ uri, mimeType: RESOURCE_MIME_TYPE, text: html }),
  };
}

export function getAppResources(): Resource[] {
  return [
    appResource(LIST_PROJECTS_UI_URI, 'List projects view', listProjectsHtml),
    appResource(LIST_TABLES_UI_URI, 'List tables view', listTablesHtml),
  ];
}
