import packageJson from '../package.json' with { type: 'json' };

export type {
  ObservationContext,
  ObservationEnd,
  ObservationFact,
  ObservedMethod,
  ObservedTool,
  ConfirmationFeature,
  RequestObservation,
  RequestObserver,
} from './observation.js';
export {
  isToolCallerError,
  ToolCallerError,
  type ToolCallerErrorKind,
} from '@supabase/mcp-utils';
export type { ToolCallCallback } from '@supabase/mcp-utils';
export {
  createFeedbackOperations,
  type FeedbackOperationsOptions,
} from './platform/feedback.js';
export type { FeedbackOperations, SupabasePlatform } from './platform/index.js';
export {
  createSupabaseMcpServer,
  type SupabaseMcpServerOptions,
} from './server.js';
export { createSupabaseMcpHandler } from './transports/http.js';
export {
  CURRENT_ELICITATION_TOOLS,
  CURRENT_FEATURE_GROUPS,
  type ElicitationToolName,
  type FeatureGroup,
} from './types.js';
export const version = packageJson.version;

export {
  createToolSchemas,
  supabaseMcpToolSchemas,
} from './tools/tool-schemas.js';
export {
  CREATE_BRANCH_UI_URI,
  CREATE_PROJECT_UI_URI,
  SHOW_ISSUES_UI_URI,
  SHOW_QUERY_UI_URI,
} from './resources/app-resources.js';
