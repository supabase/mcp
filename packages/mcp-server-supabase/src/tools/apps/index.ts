import type { ClientCapabilities } from '@modelcontextprotocol/server';
import type { Tool } from '@supabase/mcp-utils';

import { SURFACE_MIME_TYPE, surfaceResources } from '../../apps/contracts.js';
import { createAppContext, type AppToolOptions } from './context.js';
import { getDataTools } from './data-tools.js';
import { getLaunchTools } from './launch-tools.js';

export type { AppToolOptions } from './context.js';
export {
  type AppAssets,
  type AppsOptions,
  APPS_BUILD_COMMAND,
  getAppResources,
} from './resources.js';

/** The MCP Apps extension identifier in client capabilities. */
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';

/**
 * Whether a client renders MCP Apps: `true` or `false` from its advertised
 * capabilities, `undefined` when they are not known.
 */
export function clientSupportsApps(
  capabilities: ClientCapabilities | undefined
): boolean | undefined {
  if (!capabilities) return undefined;
  const extensions = (capabilities as { extensions?: Record<string, unknown> })
    .extensions;
  const ui = extensions?.[MCP_APPS_EXTENSION] as
    | { mimeTypes?: unknown }
    | undefined;
  if (!ui) return false;
  // Hosts may omit mimeTypes; when listed, ours must be among them.
  return (
    !Array.isArray(ui.mimeTypes) || ui.mimeTypes.includes(SURFACE_MIME_TYPE)
  );
}

/** MCP Apps tools: model-visible launches plus app-only data operations. */
export function getAppTools(options: AppToolOptions): Record<string, Tool> {
  const app = createAppContext(options);
  return { ...getLaunchTools(app), ...getDataTools(app) };
}

/**
 * Model tools whose own results render as a view, keyed by tool name. The view
 * reads the tool's normal result, so the model sees the same output either way.
 */
const toolResultViews = {
  create_project: 'project-card',
} as const satisfies Record<string, keyof typeof surfaceResources>;

/** Points model tools that have a view at it. Only for clients that render MCP Apps. */
export function attachToolResultViews<T extends Pick<Tool, '_meta'>>(
  tools: Record<string, T>
) {
  for (const [name, surface] of Object.entries(toolResultViews)) {
    const tool = tools[name];
    if (!tool) continue;
    const { uri, preferredDisplayMode } = surfaceResources[surface];
    tools[name] = {
      ...tool,
      _meta: {
        ...tool._meta,
        ui: { resourceUri: uri, visibility: ['model', 'app'] },
        'openai/ui': { preferredModelDisplayMode: preferredDisplayMode },
      },
    };
  }
}
