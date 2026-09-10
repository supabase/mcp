import packageJson from '../package.json' with { type: 'json' };

export type { ToolCallCallback } from '@supabase/mcp-utils';
export type { SupabasePlatform } from './platform/index.js';
export {
  createSupabaseMcpServer,
  type SupabaseMcpServerOptions,
} from './server.js';
export { createSupabaseMcpHandler } from './transports/http.js';
export {
  CURRENT_FEATURE_GROUPS,
  type FeatureGroup,
} from './types.js';
export const version = packageJson.version;

export {
  createToolSchemas,
  supabaseMcpToolSchemas,
} from './tools/tool-schemas.js';
export {
  createOAuthScopeHints,
  createToolAccessHints,
  supabaseMcpToolAccessHints,
  type OAuthScopeHint,
  type OAuthScopeHintSource,
  type OAuthScopeLevel,
  type OAuthScopeResource,
  type ToolAccessEntry,
} from './tools/tool-access.js';
