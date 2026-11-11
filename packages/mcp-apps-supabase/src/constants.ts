/** MCP Apps extension ID, used as the key in `capabilities.extensions`. */
export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';

/** MIME type for MCP App HTML resources. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const API_GATEWAY_REPORT_RESOURCE_URI =
  'ui://supabase/api-gateway-report';

/** Model-visible tool that renders the report. */
export const SHOW_API_GATEWAY_REPORT_TOOL = 'show_api_gateway_report';

/** App-only tool the iframe calls to refresh / change the time range. */
export const GET_API_GATEWAY_REPORT_DATA_TOOL = 'get_api_gateway_report_data';

export const TIME_RANGES = ['10m', '30m', '1h', '3h', '24h'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];
export const DEFAULT_TIME_RANGE: TimeRange = '1h';
