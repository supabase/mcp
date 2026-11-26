import type { Resource } from '@supabase/mcp-utils';
import { getAppResources } from './app-resources.js';

export type ResourceSetOptions = {
  /** Whether this request gets MCP Apps views (see `appsEnabled`). */
  apps: boolean;
  /** Whether this request gets OpenAI plugin extensions (see `openaiPluginExtensionsEnabled`). */
  openaiPluginExtensions?: boolean;
};

/** Composes the resources a request can list and read. */
export function getResources({
  apps,
  openaiPluginExtensions = false,
}: ResourceSetOptions): Resource[] {
  return apps ? getAppResources({ openaiPluginExtensions }) : [];
}
