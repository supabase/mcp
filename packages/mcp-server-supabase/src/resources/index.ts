import type { Resource } from '@supabase/mcp-utils';
import { getAppResources } from './app-resources.js';

export type ResourceSetOptions = {
  /** Whether this request gets MCP Apps views (see `appsEnabled`). */
  apps: boolean;
};

/** Composes the resources a request can list and read. */
export function getResources({ apps }: ResourceSetOptions): Resource[] {
  return apps ? getAppResources() : [];
}
