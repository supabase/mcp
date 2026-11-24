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
import showIssuesHtml from '@supabase/mcp-ui/show-issues.html';
import showLogsHtml from '@supabase/mcp-ui/show-logs.html';
import showQueryHtml from '@supabase/mcp-ui/show-query.html';
import showRowHtml from '@supabase/mcp-ui/show-row.html';

export const CREATE_PROJECT_UI_URI = 'ui://supabase/create-project';
export const CREATE_BRANCH_UI_URI = 'ui://supabase/create-branch';
export const SHOW_ISSUES_UI_URI = 'ui://supabase/show-issues';
export const SHOW_QUERY_UI_URI = 'ui://supabase/show-query';
export const SHOW_ROW_UI_URI = 'ui://supabase/show-row';
export const SHOW_LOGS_UI_URI = 'ui://supabase/show-logs';

const BASE_VIEW_UI: McpUiResourceMeta = {
  // Views are fully inlined and make no network requests.
  csp: { connectDomains: [], resourceDomains: [] },
  // Views blend into the conversation instead of sitting in a host frame.
  prefersBorder: false,
  // Views let the user copy connection details.
  permissions: { clipboardWrite: {} },
};

/**
 * Where a host shows a view, as the Supabase surfaces define it: `inline` in
 * the conversation (a card), `expandable` inline with a way to open it in a
 * panel (a query block), or a `panel` beside the conversation (issues, logs,
 * a row) that the user works in. A panel prefers fullscreen, which Claude opens in
 * its side panel without a click and ChatGPT opens fullscreen.
 */
export type ViewPresentation = 'inline' | 'expandable' | 'panel';

type DisplayMode = 'inline' | 'fullscreen';

const DISPLAY_MODES: Record<
  ViewPresentation,
  { preferred: DisplayMode; available: DisplayMode[] }
> = {
  inline: { preferred: 'inline', available: ['inline'] },
  expandable: { preferred: 'inline', available: ['inline', 'fullscreen'] },
  panel: { preferred: 'fullscreen', available: ['fullscreen'] },
};

/** Resource `_meta` for a view, for every host. */
export function viewResourceMeta(presentation: ViewPresentation) {
  const { preferred, available } = DISPLAY_MODES[presentation];
  return {
    // `preferredDisplayMode` is Claude's extension to the MCP Apps standard.
    ui: { ...BASE_VIEW_UI, preferredDisplayMode: preferred },
    'openai/ui': {
      preferredDisplayMode: preferred,
      availableDisplayModes: available,
    },
  };
}

/**
 * Tool `_meta` for a tool that opens a view: the view's resource, and for
 * ChatGPT, the mode a model call opens it in.
 */
export function viewToolMeta(
  resourceUri: string,
  presentation: ViewPresentation
) {
  return {
    ui: { resourceUri },
    'openai/ui': {
      preferredModelDisplayMode: DISPLAY_MODES[presentation].preferred,
    },
  };
}

function appResource(
  uri: string,
  name: string,
  description: string,
  html: string,
  presentation: ViewPresentation = 'inline'
): Resource {
  const meta = viewResourceMeta(presentation);
  return resource(uri, {
    name,
    description,
    mimeType: RESOURCE_MIME_TYPE,
    _meta: meta,
    // Hosts read `_meta` from the content first, so send it here too.
    read: async () => ({
      uri,
      mimeType: RESOURCE_MIME_TYPE,
      text: html,
      _meta: meta,
    }),
  });
}

export function getAppResources(): Resource[] {
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
    appResource(
      SHOW_ISSUES_UI_URI,
      'Issues view',
      "A project's security and performance advisor issues, for the show_issues tool.",
      showIssuesHtml,
      'panel'
    ),
    appResource(
      SHOW_QUERY_UI_URI,
      'Query view',
      'A SQL query and its results, editable and runnable, for the show_query tool.',
      showQueryHtml,
      'expandable'
    ),
    appResource(
      SHOW_ROW_UI_URI,
      'Row view',
      'One table row, editable by the user, for the show_row tool.',
      showRowHtml,
      'panel'
    ),
    appResource(
      SHOW_LOGS_UI_URI,
      'Logs view',
      'Recent project logs to search, filter and select, for the show_logs tool.',
      showLogsHtml,
      'panel'
    ),
  ];
}
