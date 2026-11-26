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
import createBranchHtml from '@supabase/mcp-ui/create-branch.html';
import createProjectHtml from '@supabase/mcp-ui/create-project.html';

export const CREATE_PROJECT_UI_URI = 'ui://supabase/create-project';
export const CREATE_BRANCH_UI_URI = 'ui://supabase/create-branch';

const VIEW_META: { ui: McpUiResourceMeta } = {
  ui: {
    // Views are fully inlined and make no network requests.
    csp: { connectDomains: [], resourceDomains: [] },
    // Views blend into the conversation instead of sitting in a host frame.
    prefersBorder: false,
    // Views let the user copy connection details.
    permissions: { clipboardWrite: {} },
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

export type AppResourcesOptions = {
  openaiPluginExtensions?: boolean;
};

export function getAppResources(
  _options: AppResourcesOptions = {}
): Resource[] {
  return [
    appResource(
      CREATE_PROJECT_UI_URI,
      'Create project view',
      'Live provisioning progress for the create_project tool.',
      createProjectHtml
    ),
    appResource(
      CREATE_BRANCH_UI_URI,
      'Create branch view',
      'Live setup progress for the create_branch tool.',
      createBranchHtml
    ),
  ];
}
