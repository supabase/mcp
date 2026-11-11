import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  type ClientCapabilities,
  createRequestStateCodec,
  type Implementation,
  isSpecType,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  createMcpServer,
  type Tool,
  type ToolCallCallback,
} from '@supabase/mcp-utils';
import packageJson from '../package.json' with { type: 'json' };
import { z } from 'zod/v4';
import type {
  ObservationFact,
  ObservedTool,
  RequestObserver,
} from './observation.js';
import { createContentApiClient } from './content-api/index.js';
import type { SupabasePlatform } from './platform/types.js';
import { getAccountTools } from './tools/account-tools.js';
import {
  type AppsOptions,
  clientSupportsApps,
  getAppResources,
  getAppTools,
} from './tools/apps/index.js';
import { getBranchingTools } from './tools/branching-tools.js';
import {
  type ElicitationState,
  ExpiredRequestState,
  isFormCapable,
  isUrlCapable,
  stopExpiredState,
} from './tools/confirmation.js';
import { getDatabaseTools } from './tools/database-operation-tools.js';
import { getDebuggingTools } from './tools/debugging-tools.js';
import { getDevelopmentTools } from './tools/development-tools.js';
import { getDocsTools } from './tools/docs-tools.js';
import { getEdgeFunctionTools } from './tools/edge-function-tools.js';
import { getFeedbackTools } from './tools/feedback-tools.js';
import { getNotebookTools } from './tools/notebook-tools.js';
import {
  assertValidConnectUrlTemplate,
  getSecretTools,
} from './tools/secret-tools.js';
import { getStorageTools } from './tools/storage-tools.js';
import { writeToolSet } from './tools/tool-schemas.js';
import {
  CURRENT_ELICITATION_TOOLS,
  type ElicitationToolName,
  type FeatureGroup,
} from './types.js';
import { parseFeatureGroups } from './util.js';

const { version } = packageJson;

// Clients on protocol 2026-07-28 send their info in each request instead of an initialize handshake
function getRequestClientInfo(ctx: ServerContext | undefined) {
  const envelope = ctx?.mcpReq.envelope;
  if (!envelope || !(CLIENT_INFO_META_KEY in envelope)) return undefined;
  const client = envelope[CLIENT_INFO_META_KEY];
  return isSpecType.Implementation(client) ? client : undefined;
}

function getRequestClientCapabilities(ctx: ServerContext | undefined) {
  const envelope = ctx?.mcpReq.envelope;
  if (!envelope || !(CLIENT_CAPABILITIES_META_KEY in envelope))
    return undefined;
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY];
  return capabilities && typeof capabilities === 'object'
    ? (capabilities as ClientCapabilities)
    : undefined;
}

export type SupabaseMcpServerOptions = {
  /**
   * Opt-in MCP Apps: interactive surfaces (project browser, SQL, logs and row
   * panels, inline query blocks) for hosts such as ChatGPT and Claude. The
   * surfaces are built by `apps/mcp-apps` in the Supabase monorepo; `assets`
   * says where the server finds them.
   */
  apps?: AppsOptions;
  /**
   * Platform implementation for Supabase.
   */
  platform: SupabasePlatform;

  /**
   * The API URL for the Supabase Content API.
   */
  contentApiUrl?: string;
  /** Dashboard base URL for notebook links. Defaults to the production dashboard. */
  dashboardUrl?: string;

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
   * Options: 'account', 'branching', 'database', 'debugging', 'development', 'docs', 'feedback', 'functions', 'notebooks', 'storage'
   */
  features?: string[];

  /**
   * Callback for after a supabase tool is called.
   */
  onToolCall?: ToolCallCallback;

  /**
   * The connected MCP client. Hosts that serve legacy clients statelessly must
   * pass the client from their restored session, since a fresh server never
   * sees `initialize`. Requests and handshakes the server sees take precedence.
   */
  clientInfo?: Implementation;

  /**
   * The connected client's capabilities, restored the same way as
   * `clientInfo`. Lets `apps` leave out its tools for clients without MCP Apps
   * support on stateless legacy requests.
   */
  clientCapabilities?: ClientCapabilities;

  /** Optional per-request observer; see ObservedMethod for covered handlers. */
  observer?: RequestObserver;

  /**
   * Signed multi-round-trip elicitation config. `requestState` is the shared
   * HMAC codec config used by every elicitation feature this server issues;
   * enable features by setting their sub-options.
   */
  elicitation?: {
    requestState: {
      /** HMAC key for the `requestState` codec. MUST be at least 32 bytes. */
      key: string | Uint8Array;
      /** The authenticated principal `requestState` is bound to. */
      principal: string;
    };
    /**
     * Form confirmation for the listed cost, destructive SQL and notebook
     * tools. Clients without form capability run raw SQL without a prompt,
     * but cannot run mutating notebook cells when confirmation is enabled.
     * Cost tools keep the legacy `get_cost` -> `confirm_cost` ->
     * `confirm_cost_id` flow.
     */
    confirmation?: {
      /** Tools that accept a confirmation elicitation. Empty disables all forms. */
      enabledTools: readonly ElicitationToolName[];
      /** How long a confirmation `requestState` stays valid, in seconds. Defaults to 600. */
      ttlSeconds?: number;
    };
    /**
     * URL-mode secret collection for `create_edge_function_secret`. Requires
     * `platform.secrets` and the functions feature group. Only URL-capable
     * clients get the tool.
     */
    secretCollection?: {
      /**
       * URL template of the dashboard page that collects the secret value.
       * MUST contain the `{ref}` and `{name}` placeholders; each is replaced
       * with the percent-encoded project ref and secret name.
       * Example: `https://supabase.com/dashboard/mcp/secrets?ref={ref}&name={name}`.
       */
      connectUrlTemplate: string;
      /** How long a secret-collection `requestState` stays valid, in seconds. Defaults to 600. */
      ttlSeconds?: number;
    };
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
  'feedback',
  'notebooks',
];

export const PLATFORM_INDEPENDENT_FEATURES: FeatureGroup[] = ['docs'];

export const instructions = `
Here are guidelines for using Supabase tools effectively:

- Before making schema changes, inspect the existing tables so you understand the current structure
- When debugging issues, start by reading the project's logs and its security, performance, and health advisories before making changes
- Look up the project's API URL and its publishable API keys when helping users configure client-side integrations
- SQL runs on the project's database server. Never read server-side files or run OS commands via SQL.

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
    dashboardUrl,
    onToolCall,
    observer,
    elicitation,
  } = options;

  if (elicitation?.secretCollection) {
    assertValidConnectUrlTemplate(
      elicitation.secretCollection.connectUrlTemplate
    );
  }
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

  const enabledConfirmationTools =
    elicitation?.confirmation?.enabledTools ?? [];
  // Each flow uses its own TTL for minting and for its expired message.
  const confirmationTtlSeconds = elicitation?.confirmation?.ttlSeconds ?? 600;
  const secretCollectionTtlSeconds =
    elicitation?.secretCollection?.ttlSeconds ?? 600;
  const codecOptions = elicitation && {
    key: elicitation.requestState.key,
    bind: (ctx: ServerContext) =>
      `${ctx.mcpReq.method}:${elicitation.requestState.principal}`,
  };
  const confirmationCodec =
    codecOptions && enabledConfirmationTools.length > 0
      ? createRequestStateCodec<ElicitationState>({
          ...codecOptions,
          ttlSeconds: confirmationTtlSeconds,
        })
      : undefined;
  const secretCollectionCodec =
    codecOptions && elicitation?.secretCollection
      ? createRequestStateCodec<ElicitationState>({
          ...codecOptions,
          ttlSeconds: secretCollectionTtlSeconds,
        })
      : undefined;
  // Both codecs share the HMAC key and binding. The SDK verifies each token's
  // signed expiry; a codec's configured TTL only affects tokens it mints.
  const verificationCodec = confirmationCodec ?? secretCollectionCodec;

  let handshakeClientInfo: Implementation | undefined;
  let handshakeClientCapabilities: ClientCapabilities | undefined;

  const appResources = options.apps ? getAppResources(options.apps) : undefined;

  const server = createMcpServer<ObservedTool, ObservationFact>({
    name: 'supabase',
    title: 'Supabase',
    version,
    instructions,
    async onInitialize(info) {
      handshakeClientInfo = info.clientInfo;
      handshakeClientCapabilities = info.clientCapabilities;
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
    observer,
    classifyTool: (name) =>
      (CURRENT_ELICITATION_TOOLS as readonly string[]).includes(name)
        ? (name as ElicitationToolName)
        : 'other',
    requestState: verificationCodec && {
      // The codec checks the MAC before expiry, so 'expired' means an
      // authentic token. Every other failure still becomes the SDK's -32602.
      verify: async (state, ctx) => {
        try {
          return await verificationCodec.verify(state, ctx);
        } catch (error) {
          if (error instanceof Error && error.message === 'expired') {
            return new ExpiredRequestState();
          }
          throw error;
        }
      },
    },
    resources: appResources,
    tools: async (ctx) => {
      const clientInfo =
        getRequestClientInfo(ctx) ?? handshakeClientInfo ?? options.clientInfo;
      const contentApiClient = await contentApiClientPromise;
      const {
        account,
        database,
        functions,
        debugging,
        development,
        storage,
        branching,
        secrets,
        notebooks,
        feedback,
      } = platform;
      const tools: Record<
        string,
        Tool<z.ZodObject<any>, z.ZodObject<any>, ObservationFact>
      > = {};

      if (enabledFeatures.has('docs')) {
        Object.assign(tools, getDocsTools({ contentApiClient }));
      }

      if (!projectId && account && enabledFeatures.has('account')) {
        Object.assign(
          tools,
          getAccountTools({
            account,
            readOnly,
            confirmation:
              confirmationCodec &&
              enabledConfirmationTools.includes('create_project')
                ? { codec: confirmationCodec }
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
            confirmation:
              confirmationCodec &&
              (enabledConfirmationTools.includes('execute_sql') ||
                enabledConfirmationTools.includes('apply_migration'))
                ? {
                    codec: confirmationCodec,
                    enabledTools: enabledConfirmationTools.filter(
                      (tool): tool is 'execute_sql' | 'apply_migration' =>
                        tool === 'execute_sql' || tool === 'apply_migration'
                    ),
                  }
                : undefined,
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
            confirmation:
              confirmationCodec &&
              enabledConfirmationTools.includes('create_branch')
                ? { codec: confirmationCodec }
                : undefined,
          })
        );
      }

      if (storage && enabledFeatures.has('storage')) {
        Object.assign(tools, getStorageTools({ storage, projectId, readOnly }));
      }

      if (notebooks && enabledFeatures.has('notebooks')) {
        Object.assign(
          tools,
          getNotebookTools({
            notebooks,
            // Feature groups control tool discovery, not the operations that
            // notebook cells can run. The notebooks group owns this tool.
            database,
            debugging,
            projectId,
            dashboardUrl,
            readOnly,
            confirmation:
              confirmationCodec &&
              (enabledConfirmationTools.includes('run_notebook') ||
                enabledConfirmationTools.includes('delete_notebook'))
                ? {
                    codec: confirmationCodec,
                    enabledTools: enabledConfirmationTools.filter(
                      (tool): tool is 'run_notebook' | 'delete_notebook' =>
                        tool === 'run_notebook' || tool === 'delete_notebook'
                    ),
                  }
                : undefined,
          })
        );
      }

      if (feedback && enabledFeatures.has('feedback')) {
        Object.assign(
          tools,
          getFeedbackTools({ feedback, projectId, clientInfo, readOnly })
        );
      }

      if (
        elicitation?.secretCollection &&
        secrets &&
        secretCollectionCodec &&
        enabledFeatures.has('functions')
      ) {
        const secretTools = getSecretTools({
          secrets,
          projectId,
          readOnly,
          codec: secretCollectionCodec,
          connectUrlTemplate: elicitation.secretCollection.connectUrlTemplate,
        });
        secretTools.create_edge_function_secret.hidden =
          !ctx || !isUrlCapable(ctx);
        Object.assign(tools, secretTools);
      }

      // Every tool that resumes signed state answers an expired token first,
      // before its own routing can ignore it.
      for (const name of [
        ...CURRENT_ELICITATION_TOOLS,
        'create_edge_function_secret',
      ]) {
        const tool = tools[name];
        if (tool) {
          tools[name] = stopExpiredState(
            name,
            tool,
            name === 'create_edge_function_secret'
              ? secretCollectionTtlSeconds
              : confirmationTtlSeconds
          );
        }
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
        confirmationCodec &&
        elicitation?.confirmation &&
        ctx &&
        isFormCapable(ctx)
      ) {
        const legacyCostTypes: ('project' | 'branch')[] = [];
        for (const type of ['project', 'branch'] as const) {
          const name = `create_${type}` as const;
          const tool = tools[name];
          if (!enabledConfirmationTools.includes(name)) {
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

      const clientCapabilities =
        getRequestClientCapabilities(ctx) ??
        handshakeClientCapabilities ??
        options.clientCapabilities;
      if (
        options.apps &&
        (options.apps.clients === 'all' ||
          clientSupportsApps(clientCapabilities) !== false)
      ) {
        Object.assign(
          tools,
          getAppTools({
            platform,
            projectId,
            readOnly,
            accountEnabled: enabledFeatures.has('account'),
            databaseEnabled: enabledFeatures.has('database'),
            debuggingEnabled: enabledFeatures.has('debugging'),
            appLinkBase: options.apps.appLinkBase,
            serverVersion: version,
            creationMode:
              confirmationCodec &&
              enabledConfirmationTools.includes('create_project') &&
              ctx &&
              isFormCapable(ctx)
                ? 'elicitation'
                : 'legacy',
          })
        );
      }

      return tools;
    },
  });

  return server;
}

function isNonEmpty<T>(items: readonly T[]): items is readonly [T, ...T[]] {
  return items.length > 0;
}
