import { createRequestStateCodec } from '@modelcontextprotocol/server';
import {
  createMcpServer,
  type Tool,
  type ToolCallCallback,
} from '@supabase/mcp-utils';
import packageJson from '../package.json' with { type: 'json' };
import { createContentApiClient } from './content-api/index.js';
import type { SupabasePlatform } from './platform/types.js';
import { getAccountTools } from './tools/account-tools.js';
import { getBranchingTools } from './tools/branching-tools.js';
import {
  type CostConfirmationState,
  isFormCapable,
} from './tools/cost-confirmation.js';
import { getDatabaseTools } from './tools/database-operation-tools.js';
import { getDebuggingTools } from './tools/debugging-tools.js';
import { getDevelopmentTools } from './tools/development-tools.js';
import { getDocsTools } from './tools/docs-tools.js';
import { getEdgeFunctionTools } from './tools/edge-function-tools.js';
import { getStorageTools } from './tools/storage-tools.js';
import { writeToolSet } from './tools/tool-schemas.js';
import type { FeatureGroup } from './types.js';
import { parseFeatureGroups } from './util.js';
import { z } from 'zod/v4';

const { version } = packageJson;

export type SupabaseMcpServerOptions = {
  /**
   * Platform implementation for Supabase.
   */
  platform: SupabasePlatform;

  /**
   * The API URL for the Supabase Content API.
   */
  contentApiUrl?: string;

  /**
   * The project ID to scope the server to.
   *
   * If undefined, the server will have access
   * to all organizations and projects for the user.
   */
  projectId?: string;

  /**
   * Executes database queries in read-only mode if true.
   */
  readOnly?: boolean;

  /**
   * Features to enable.
   * Options: 'account', 'branching', 'database', 'debugging', 'development', 'docs', 'functions', 'storage'
   */
  features?: string[];

  /**
   * Callback for after a supabase tool is called.
   */
  onToolCall?: ToolCallCallback;

  /**
   * Enables cost confirmation via elicitation for clients that declare
   * per-request form-elicitation capability. Clients without that
   * capability keep using `get_cost` -> `confirm_cost` -> the relevant
   * project or branch `confirm_cost_id` flow (`create_project` or
   * `create_branch`).
   */
  costConfirmation?: {
    /** HMAC key for the `requestState` codec. MUST be at least 32 bytes. */
    requestStateKey: string | Uint8Array;
    /** The authenticated principal `requestState` is bound to. */
    principal: string;
    /** How long a minted `requestState` stays valid, in seconds. */
    ttlSeconds?: number;
    /** Tools that accept a cost-confirmation elicitation. */
    enabledTools: readonly ('create_project' | 'create_branch')[];
  };
};

const DEFAULT_FEATURES: FeatureGroup[] = [
  'docs',
  'account',
  'database',
  'debugging',
  'development',
  'functions',
  'branching',
];

export const PLATFORM_INDEPENDENT_FEATURES: FeatureGroup[] = ['docs'];

export const instructions = `
Here are guidelines for using Supabase tools effectively:

- Before making schema changes, inspect the existing tables so you understand the current structure
- When debugging issues, start by reading the project's logs and its security and performance advisories before making changes
- Look up the project's API URL and its publishable API keys when helping users configure client-side integrations
- The project database runs on shared Supabase infrastructure; its host filesystem and OS are not the user's. Do not read server-side files or run OS commands via SQL.

If you have access to a local development environment with a filesystem and shell:
- Install the Supabase agent skill for critical development and security guidance: \`npx skills add supabase/agent-skills\` (https://supabase.com/docs/guides/getting-started/ai-skills.md)
- Use the Supabase CLI (\`supabase\`) for local development workflows such as starting a local stack, managing migrations, and running edge functions locally (https://supabase.com/docs/guides/local-development.md)
- Prefer local development and testing before applying changes to a remote project

If you are running in a web-only or remote environment without filesystem or shell access:
- Rely on the MCP tools directly for all Supabase interactions
- Apply schema migrations carefully, as changes go directly to the remote project
`.trim();

/**
 * Creates an MCP server for interacting with Supabase.
 */
export function createSupabaseMcpServer(options: SupabaseMcpServerOptions) {
  const {
    platform,
    projectId,
    readOnly,
    features,
    contentApiUrl = 'https://supabase.com/docs/api/graphql',
    onToolCall,
    costConfirmation,
  } = options;

  const contentApiClientPromise = createContentApiClient(contentApiUrl, {
    'User-Agent': `supabase-mcp/${version}`,
  });

  // Filter the default features based on the platform's capabilities
  const availableDefaultFeatures = DEFAULT_FEATURES.filter(
    (key) =>
      PLATFORM_INDEPENDENT_FEATURES.includes(key) ||
      Object.keys(platform).includes(key)
  );

  // Validate the desired features against the platform's available features
  const enabledFeatures = parseFeatureGroups(
    platform,
    features ?? availableDefaultFeatures
  );

  const costConfirmationCodec = costConfirmation?.enabledTools.length
    ? createRequestStateCodec<CostConfirmationState>({
        key: costConfirmation.requestStateKey,
        ttlSeconds: costConfirmation.ttlSeconds,
        bind: (ctx) => `${ctx.mcpReq.method}:${costConfirmation.principal}`,
      })
    : undefined;

  const server = createMcpServer({
    name: 'supabase',
    title: 'Supabase',
    version,
    instructions,
    async onInitialize(info) {
      // Note: in stateless HTTP mode, `onInitialize` will not always be called
      // so we cannot rely on it for initialization. It's still useful for telemetry.
      const { clientInfo } = info;
      const userAgent = `supabase-mcp/${version} (${clientInfo.name}/${clientInfo.version})`;

      await Promise.all([
        platform.init?.(info),
        contentApiClientPromise.then((client) =>
          client.setUserAgent(userAgent)
        ),
      ]);
    },
    onToolCall,
    requestState: costConfirmationCodec && {
      verify: costConfirmationCodec.verify,
    },
    tools: async (ctx) => {
      const contentApiClient = await contentApiClientPromise;
      const tools: Record<string, Tool> = {};

      const {
        account,
        database,
        functions,
        debugging,
        development,
        storage,
        branching,
      } = platform;

      if (enabledFeatures.has('docs')) {
        Object.assign(tools, getDocsTools({ contentApiClient }));
      }

      if (!projectId && account && enabledFeatures.has('account')) {
        Object.assign(
          tools,
          getAccountTools({
            account,
            readOnly,
            costConfirmation:
              costConfirmationCodec &&
              costConfirmation?.enabledTools.includes('create_project')
                ? { codec: costConfirmationCodec }
                : undefined,
          })
        );
      }

      if (database && enabledFeatures.has('database')) {
        Object.assign(
          tools,
          getDatabaseTools({
            database,
            projectId,
            readOnly,
          })
        );
      }

      if (debugging && enabledFeatures.has('debugging')) {
        Object.assign(tools, getDebuggingTools({ debugging, projectId }));
      }

      if (development && enabledFeatures.has('development')) {
        Object.assign(tools, getDevelopmentTools({ development, projectId }));
      }

      if (functions && enabledFeatures.has('functions')) {
        Object.assign(
          tools,
          getEdgeFunctionTools({ functions, projectId, readOnly })
        );
      }

      if (branching && enabledFeatures.has('branching')) {
        Object.assign(
          tools,
          getBranchingTools({
            branching,
            projectId,
            readOnly,
            costConfirmation:
              costConfirmationCodec &&
              costConfirmation?.enabledTools.includes('create_branch')
                ? { codec: costConfirmationCodec }
                : undefined,
          })
        );
      }

      if (storage && enabledFeatures.has('storage')) {
        Object.assign(tools, getStorageTools({ storage, projectId, readOnly }));
      }

      if (readOnly) {
        for (const [name, tool] of Object.entries(tools)) {
          if (writeToolSet.has(name)) {
            tools[name] = { ...tool, hidden: true };
          }
        }
      }

      // Form-capable clients confirm cost inside the create tools, so those
      // drop `confirm_cost_id` and the legacy cost tools only offer the types
      // that still need them. With nothing left to quote they are hidden
      // entirely.
      if (
        costConfirmationCodec &&
        costConfirmation &&
        ctx &&
        isFormCapable(ctx)
      ) {
        const legacyCostTypes: ('project' | 'branch')[] = [];
        for (const type of ['project', 'branch'] as const) {
          const name = `create_${type}` as const;
          const tool = tools[name];
          if (!costConfirmation.enabledTools.includes(name)) {
            legacyCostTypes.push(type);
          } else if (tool) {
            tools[name] = {
              ...tool,
              parameters: tool.parameters.omit({ confirm_cost_id: true }),
            };
          }
        }

        for (const name of ['get_cost', 'confirm_cost']) {
          const tool = tools[name];
          if (!tool) {
            continue;
          }
          tools[name] = isNonEmpty(legacyCostTypes)
            ? {
                ...tool,
                parameters: tool.parameters.extend({
                  type: z.enum(legacyCostTypes),
                }),
              }
            : { ...tool, hidden: true };
        }
      }

      return tools;
    },
  });

  return server;
}

function isNonEmpty<T>(items: readonly T[]): items is readonly [T, ...T[]] {
  return items.length > 0;
}
