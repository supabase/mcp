import { isCallToolResult, Server } from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  ClientCapabilities,
  Implementation,
  InputRequiredResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  Tool as McpTool,
  ReadResourceResult,
  ServerCapabilities,
  ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import type { ExtractParams } from './types.js';
import { assertValidUri, compareUris, matchUriTemplate } from './util.js';

export type Scheme = string;
export type Annotations = NonNullable<
  ListToolsResult['tools'][number]['annotations']
>;

export type Resource<Uri extends string = string, Result = unknown> = {
  uri: Uri;
  name: string;
  description?: string;
  mimeType?: string;
  read(uri: `${Scheme}://${Uri}`): Promise<Result>;
};

export type ResourceTemplate<Uri extends string = string, Result = unknown> = {
  uriTemplate: Uri;
  name: string;
  description?: string;
  mimeType?: string;
  read(
    uri: `${Scheme}://${Uri}`,
    params: {
      [Param in ExtractParams<Uri>]: string;
    }
  ): Promise<Result>;
};

export type Tool<
  Params extends z.ZodObject<any> = z.ZodObject<any>,
  // MCP spec restricts outputSchema to type "object" at the root level:
  // https://modelcontextprotocol.io/specification/2025-11-25/schema#tool-outputschema
  OutputSchema extends z.ZodObject<any> = z.ZodObject<any>,
> = {
  description: Prop<string>;
  annotations?: Annotations;
  parameters: Params;
  outputSchema: OutputSchema;
  /** If true, excludes the tool from `tools/list` while keeping it callable via `tools/call`. */
  hidden?: boolean;
  /**
   * Executes the tool. `ctx` is the SDK's per-request `ServerContext`
   * (elicitation, multi-round-trip `requestState`, HTTP info, etc.) — most
   * tools ignore it.
   *
   * Returning an `InputRequiredResult` or a direct `CallToolResult` is
   * passed straight to the client instead of being JSON-wrapped; any other
   * value is wrapped as today (`{ content: [{ type: 'text', text:
   * JSON.stringify(value) }] }`).
   */
  execute(
    params: z.infer<Params>,
    ctx: ServerContext
  ): Promise<z.infer<OutputSchema> | InputRequiredResult | CallToolResult>;
};

/**
 * Helper function to define an MCP resource while preserving type information.
 */
export function resource<Uri extends string, Result>(
  uri: Uri,
  resource: Omit<Resource<Uri, Result>, 'uri'>
): Resource<Uri, Result> {
  return {
    uri,
    ...resource,
  };
}

/**
 * Helper function to define an MCP resource with a URI template while preserving type information.
 */
export function resourceTemplate<Uri extends string, Result>(
  uriTemplate: Uri,
  resource: Omit<ResourceTemplate<Uri, Result>, 'uriTemplate'>
): ResourceTemplate<Uri, Result> {
  return {
    uriTemplate,
    ...resource,
  };
}

/**
 * Helper function to define a JSON resource while preserving type information.
 */
export function jsonResource<Uri extends string, Result>(
  uri: Uri,
  resource: Omit<Resource<Uri, Result>, 'uri' | 'mimeType'>
): Resource<Uri, Result> {
  return {
    uri,
    mimeType: 'application/json' as const,
    ...resource,
  };
}

/**
 * Helper function to define a JSON resource with a URI template while preserving type information.
 */
export function jsonResourceTemplate<Uri extends string, Result>(
  uriTemplate: Uri,
  resource: Omit<ResourceTemplate<Uri, Result>, 'uriTemplate' | 'mimeType'>
): ResourceTemplate<Uri, Result> {
  return {
    uriTemplate,
    mimeType: 'application/json' as const,
    ...resource,
  };
}

/**
 * Helper function to define a list of resources that share a common URI scheme.
 */
export function resources<Scheme extends string>(
  scheme: Scheme,
  resources: (Resource | ResourceTemplate)[]
): (
  | Resource<`${Scheme}://${string}`>
  | ResourceTemplate<`${Scheme}://${string}`>
)[] {
  return resources.map((resource) => {
    if ('uri' in resource) {
      const url = new URL(resource.uri, `${scheme}://`);
      const uri = decodeURI(url.href) as `${Scheme}://${typeof resource.uri}`;

      return {
        ...resource,
        uri,
      };
    }

    const url = new URL(resource.uriTemplate, `${scheme}://`);
    const uriTemplate = decodeURI(
      url.href
    ) as `${Scheme}://${typeof resource.uriTemplate}`;

    return {
      ...resource,
      uriTemplate,
    };
  });
}

/**
 * Helper function to create a JSON resource response.
 */
export function jsonResourceResponse<Uri extends string, Response>(
  uri: Uri,
  response: Response
) {
  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify(response),
  };
}

/**
 * Helper function to define an MCP tool while preserving type information.
 */
export function tool<
  Params extends z.ZodObject<any>,
  OutputSchema extends z.ZodObject<any>,
>(tool: Tool<Params, OutputSchema>) {
  return tool;
}

export type InitData = {
  clientInfo: Implementation;
  clientCapabilities: ClientCapabilities;
};

type ToolCallBaseDetails = {
  name: string;
  arguments: Record<string, unknown>;
  annotations?: Annotations;
};

type ToolCallSuccessDetails = ToolCallBaseDetails & {
  success: true;
  data: unknown;
};

type ToolCallErrorDetails = ToolCallBaseDetails & {
  success: false;
  error: unknown;
};

export type ToolCallDetails = ToolCallSuccessDetails | ToolCallErrorDetails;

export type InitCallback = (initData: InitData) => void | Promise<void>;
export type ToolCallCallback = (details: ToolCallDetails) => void;
export type PropCallback<T> = () => T | Promise<T>;
export type Prop<T> = T | PropCallback<T>;

export type McpServerOptions = {
  /**
   * The name of the MCP server. This will be sent to the client as part of
   * the initialization process.
   */
  name: string;

  /**
   * The title of the MCP server. This is a human-readable name that can be
   * displayed in the client UI.
   *
   * If not provided, the name will be used as the title.
   */
  title?: string;

  /**
   * The version of the MCP server. This will be sent to the client as part of
   * the initialization process.
   */
  version: string;

  /**
   * Callback for when initialization has fully completed with the client.
   */
  onInitialize?: InitCallback;

  /**
   * Optional instructions describing how to use the server and its features.
   *
   * This can be used by clients to improve the LLM's understanding of available
   * tools, resources, etc. It can be thought of like a "hint" to the model.
   * For example, this information MAY be added to the system prompt.
   */
  instructions?: string;

  /**
   * Callback for after a tool is called.
   */
  onToolCall?: ToolCallCallback;

  /**
   * Resources to be served by the server. These can be defined as a static
   * object or as a function that dynamically returns the object synchronously
   * or asynchronously.
   *
   * If defined as a function, the function will be called whenever the client
   * asks for the list of resources or reads a resource. This allows for dynamic
   * resources that can change after the server has started.
   */
  resources?: Prop<
    (Resource<string, unknown> | ResourceTemplate<string, unknown>)[]
  >;

  /**
   * Tools to be served by the server. These can be defined as a static object
   * or as a function that dynamically returns the object synchronously or
   * asynchronously.
   *
   * If defined as a function, the function will be called whenever the client
   * asks for the list of tools or invokes a tool. This allows for dynamic tools
   * that can change after the server has started.
   */
  tools?:
    | Record<string, Tool>
    | ((
        ctx?: ServerContext
      ) => Record<string, Tool> | Promise<Record<string, Tool>>);

  /**
   * Multi-round-trip `requestState` integrity hook (protocol revision
   * 2026-07-28), passed straight through to the underlying SDK `Server`.
   *
   * Configure this with `createRequestStateCodec`'s `verify` to
   * authenticate `requestState` a tool mints via `inputRequired(...)`.
   * Leaving it unset keeps the SDK's passthrough behavior.
   */
  requestState?: {
    verify?: (state: string, ctx: ServerContext) => unknown | Promise<unknown>;
  };
};

/**
 * Creates an MCP server with the given options.
 *
 * Simplifies the process of creating an MCP server by providing a high-level
 * API for defining resources and tools.
 */
export function createMcpServer(options: McpServerOptions) {
  const capabilities: ServerCapabilities = {};

  if (options.resources) {
    capabilities.resources = {};
  }

  if (options.tools) {
    capabilities.tools = {};
  }

  const server = new Server(
    {
      name: options.name,
      title: options.title,
      version: options.version,
    },
    {
      capabilities,
      instructions: options.instructions,
      requestState: options.requestState,
    }
  );

  async function getResources() {
    if (!options.resources) {
      throw new Error('resources not available');
    }

    return typeof options.resources === 'function'
      ? await options.resources()
      : options.resources;
  }

  async function getTools(ctx?: ServerContext) {
    if (!options.tools) {
      throw new Error('tools not available');
    }

    return typeof options.tools === 'function'
      ? await options.tools(ctx)
      : options.tools;
  }

  server.oninitialized = async () => {
    const clientInfo = server.getClientVersion();
    const clientCapabilities = server.getClientCapabilities();

    if (!clientInfo) {
      throw new Error('client info not available after initialization');
    }

    if (!clientCapabilities) {
      throw new Error('client capabilities not available after initialization');
    }

    const initData: InitData = {
      clientInfo,
      clientCapabilities,
    };

    await options.onInitialize?.(initData);
  };

  if (options.resources) {
    server.setRequestHandler(
      'resources/list',
      async (): Promise<ListResourcesResult> => {
        const allResources = await getResources();
        return {
          resources: allResources
            .filter((resource) => 'uri' in resource)
            .map(({ uri, name, description, mimeType }) => {
              return {
                uri,
                name,
                description,
                mimeType,
              };
            }),
        };
      }
    );

    server.setRequestHandler(
      'resources/templates/list',
      async (): Promise<ListResourceTemplatesResult> => {
        const allResources = await getResources();
        return {
          resourceTemplates: allResources
            .filter((resource) => 'uriTemplate' in resource)
            .map(({ uriTemplate, name, description, mimeType }) => {
              return {
                uriTemplate,
                name,
                description,
                mimeType,
              };
            }),
        };
      }
    );

    server.setRequestHandler(
      'resources/read',
      async (request): Promise<ReadResourceResult> => {
        try {
          const allResources = await getResources();
          const { uri } = request.params;

          const resources = allResources.filter(
            (resource) => 'uri' in resource
          );
          const resource = resources.find((resource) =>
            compareUris(resource.uri, uri)
          );

          if (resource) {
            const result = await resource.read(uri as `${string}://${string}`);

            const contents = Array.isArray(result) ? result : [result];

            return {
              contents,
            };
          }

          const resourceTemplates = allResources.filter(
            (resource) => 'uriTemplate' in resource
          );
          const resourceTemplateUris = resourceTemplates.map(
            ({ uriTemplate }) => assertValidUri(uriTemplate)
          );

          const templateMatch = matchUriTemplate(uri, resourceTemplateUris);

          if (!templateMatch) {
            throw new Error('resource not found');
          }

          const resourceTemplate = resourceTemplates.find(
            (r) => r.uriTemplate === templateMatch.uri
          );

          if (!resourceTemplate) {
            throw new Error('resource not found');
          }

          const result = await resourceTemplate.read(
            uri as `${string}://${string}`,
            templateMatch.params
          );

          const contents = Array.isArray(result) ? result : [result];

          return {
            contents,
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: enumerateError(error) }),
              },
            ],
          } as any;
        }
      }
    );
  }

  if (options.tools) {
    server.setRequestHandler(
      'tools/list',
      async (_request, ctx): Promise<ListToolsResult> => {
        const tools = await getTools(ctx);

        return {
          tools: await Promise.all(
            Object.entries(tools)
              .filter(([, tool]) => !tool.hidden)
              .map(async ([name, { description, annotations, parameters }]) => {
                const inputSchema = z.toJSONSchema(parameters, {
                  target: 'draft-7',
                });

                return {
                  name,
                  description:
                    typeof description === 'function'
                      ? await description()
                      : description,
                  annotations,
                  // Casting the same as the SDK does:
                  // https://github.com/modelcontextprotocol/typescript-sdk/blob/fb07af810b51003c338dc4885a9e42f54519f9af/src/server/mcp.ts#L154
                  inputSchema: inputSchema as McpTool['inputSchema'],
                };
              })
          ),
        } satisfies ListToolsResult;
      }
    );

    server.setRequestHandler('tools/call', async (request, ctx) => {
      try {
        const tools = await getTools(ctx);
        const toolName = request.params.name;

        if (!(toolName in tools)) {
          throw new Error('tool not found');
        }

        const tool = tools[toolName];

        if (!tool) {
          throw new Error('tool not found');
        }
        const args = tool.parameters
          .strict()
          .parse(request.params.arguments ?? {});

        const executeWithCallback = async (tool: Tool) => {
          // Wrap success or error in a result value
          const res = await tool
            .execute(args, ctx)
            .then((data: unknown) => ({ success: true as const, data }))
            .catch((error) => ({ success: false as const, error }));

          try {
            options.onToolCall?.({
              name: toolName,
              arguments: args,
              annotations: tool.annotations,
              ...res,
            });
          } catch (error) {
            // Don't fail the tool call if the callback fails
            console.error('Failed to run tool callback', error);
          }

          // Unwrap result
          if (!res.success) {
            throw res.error;
          }
          return res.data;
        };

        const result = await executeWithCallback(tool);

        // An InputRequiredResult or a direct CallToolResult is already
        // shaped for the wire; pass it through instead of JSON-wrapping it.
        if (isInputRequiredResult(result) || isCallToolResult(result)) {
          return result;
        }

        const content =
          result != null
            ? [{ type: 'text' as const, text: JSON.stringify(result) }]
            : [];

        return {
          content,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: enumerateError(error) }),
            },
          ],
        };
      }
    });
  }

  return server;
}

function isInputRequiredResult(value: unknown): value is InputRequiredResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { resultType?: unknown }).resultType === 'input_required'
  );
}

function enumerateError(error: unknown) {
  if (!error) {
    return error;
  }

  if (typeof error !== 'object') {
    return error;
  }

  const newError: Record<string, unknown> = {};

  const errorProps = ['name', 'message'] as const;

  for (const prop of errorProps) {
    if (prop in error) {
      newError[prop] = (error as Record<string, unknown>)[prop];
    }
  }

  return newError;
}
