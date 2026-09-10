# Supabase MCP Server

[![MCP Registry Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0.1%2Fservers%2Fcom.supabase%252Fmcp%2Fversions%2Flatest&query=%24.server.version&label=MCP%20Registry&logo=modelcontextprotocol)](https://registry.modelcontextprotocol.io/?q=com.supabase%2Fmcp)

> Connect your Supabase projects to Cursor, Claude, Windsurf, and other AI assistants.

![supabase-mcp-demo](https://github.com/user-attachments/assets/3fce101a-b7d4-482f-9182-0be70ed1ad56)

The [Model Context Protocol](https://modelcontextprotocol.io/introduction) (MCP) standardizes how Large Language Models (LLMs) talk to external services like Supabase. It connects AI assistants directly with your Supabase project and allows them to perform tasks like managing tables, fetching config, and querying data. See the [full list of tools](https://supabase.com/mcp#available-tools).

## Setup

### 1. Follow our security best practices

Before setting up the MCP server, we recommend you read our [security best practices](https://supabase.com/docs/guides/ai-tools/mcp#security-risks) to understand the risks of connecting an LLM to your Supabase projects and how to mitigate them.


### 2. Configure your MCP client

To configure the Supabase MCP server on your client, visit our [setup documentation](https://supabase.com/docs/guides/getting-started/mcp#step-2-configure-your-ai-tool). You can also generate a custom MCP URL for your project by visiting the [MCP connection tab](https://supabase.com/dashboard/project/_?showConnect=true&connectTab=mcp) in the Supabase dashboard.

Your MCP client will automatically prompt you to log in to Supabase during setup. Be sure to choose the organization that contains the project you wish to work with.

Most MCP clients require the following information:

```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp"
    }
  }
}
```

If you don't see your MCP client listed in our documentation, check your client's MCP documentation and copy the above MCP information into their expected format (json, yaml, etc).

#### CLI

If you're running Supabase locally with [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), you can access the MCP server at `http://localhost:54321/mcp`. Currently, the MCP Server in CLI environments offers a limited subset of tools and no OAuth 2.1.

#### Self-hosted

For [self-hosted Supabase](https://supabase.com/docs/guides/self-hosting/docker), check the [Enabling MCP server](https://supabase.com/docs/guides/self-hosting/enable-mcp) page. Currently, the MCP Server in self-hosted environments offers a limited subset of tools and no OAuth 2.1.

## Configuration options and tools

See the [Supabase MCP Server](https://supabase.com/mcp) docs for the full list of [available tools](https://supabase.com/mcp#available-tools) and [configuration options](https://supabase.com/mcp#configuration-options).

The docs also feature an interactive URL builder to populate configuration options for you.

## Usage with AI SDK's MCP Client

The `@supabase/mcp-server-supabase` package exports `createToolSchemas()` to populate input and output schemas for Vercel AI SDK's [MCP client](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools). This allows Supabase MCP tools to be treated as static tools with client-side validation and inferred TypeScript types for their inputs and outputs.

```ts
import { createToolSchemas } from '@supabase/mcp-server-supabase';
import { createMCPClient } from '@ai-sdk/mcp';
import { streamText } from 'ai';

const mcpClient = await createMCPClient({
  transport: {
    type: 'http',
    url: 'https://mcp.supabase.com/mcp',
  },
});

const tools = await mcpClient.tools({
  schemas: createToolSchemas(),
});

const result = streamText({ model, tools, prompt: '...' });

for (const step of await result.steps) {
  for (const toolResult of step.staticToolResults) {
    if (toolResult.toolName === 'get_project_url') {
      toolResult.input;  // { project_id: string }
      toolResult.output; // { url: string }
    }
  }
}
```

`createToolSchemas()` accepts similar filtering options as the MCP server's URL parameters:

- `features`: Restrict to specific [feature groups](https://supabase.com/mcp#configuration-options) (e.g. `['database', 'docs']`). Defaults to all default feature groups.
- `projectScoped`: When `true`, omits `project_id` from tool input schemas and excludes account-level tools — use when connecting to a server configured with `project_ref`. Defaults to `false`.
- `readOnly`: When `true`, excludes mutating tools — use when connecting to a server configured with `read_only=true`. Defaults to `false`.

```ts
const mcpClient = await createMCPClient({
  transport: {
    type: 'http',
    url: 'https://mcp.supabase.com/mcp?project_ref=<project-ref>&read_only=true&features=database,docs',
  },
});

const tools = await mcpClient.tools({
  schemas: createToolSchemas({
    features: ['database', 'docs'],
    projectScoped: true,
    readOnly: true,
  }),
});
```

The package also exports `createToolAccessHints()` and `createOAuthScopeHints()` for integrations that need to reason about the minimum Management API access surface implied by a given MCP configuration:

```ts
import { createOAuthScopeHints } from '@supabase/mcp-server-supabase';

createOAuthScopeHints({
  features: ['docs'],
});
// => []

createOAuthScopeHints({
  features: ['database', 'docs'],
  readOnly: true,
});
// => ['database:read']
```

By default, `createOAuthScopeHints()` only returns scope families documented in Supabase's public OAuth scope guide. Pass `includeInferred: true` to also include best-effort hints for Management API surfaces that are used by the MCP server but are not currently listed in the public scope table.

> [!NOTE]
> This server does not send `structuredContent` in MCP tool results. AI SDK falls back to parsing JSON from `content` text.

For more information, see [Schema Definition](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools#schema-definition) and [Typed Tool Outputs](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools#typed-tool-outputs) in the AI SDK docs.

## Self-hosting the MCP endpoint

The `@supabase/mcp-server-supabase` package exports `createSupabaseMcpHandler()` to serve the tools over HTTP from your own endpoint. It accepts the same `SupabaseMcpServerOptions` as `createSupabaseMcpServer()`, most importantly `platform`.

The handler speaks the current protocol revision only. It is created with `legacy: 'reject'`, so a client that only speaks the 2025-era protocol receives an HTTP 400 instead of being served.

When `platform` carries a per-request credential, create the handler per request and close it when the response finishes. The handler closes over the `platform` you supply, so a shared one serves every request with that platform.

A long-lived handler is fine when the `platform` is meant to be shared, a service-account token for example. Create it once and `close()` it at shutdown rather than per response, since `close()` tears down the subscription router and refuses later requests.

```ts
import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createSupabaseMcpHandler } from '@supabase/mcp-server-supabase';
import { createSupabaseApiPlatform } from '@supabase/mcp-server-supabase/platform/api';

const server = createServer((req, res) => {
  const accessToken = getAccessTokenFromRequest(req); // your own auth

  const handler = createSupabaseMcpHandler({
    platform: createSupabaseApiPlatform({ accessToken }),
  });

  // `close()` aborts in-flight exchanges, so close on `res` finishing rather
  // than when the handler resolves, which would cut streaming responses short.
  res.on('close', () => {
    handler.close().catch((error) => console.error(error));
  });

  toNodeHandler(handler)(req, res).catch((error) => console.error(error));
});
```

`toNodeHandler` comes from `@modelcontextprotocol/node`, which is not a dependency of this package. Install it alongside.

## Other MCP servers

### `@supabase/mcp-server-postgrest`

The PostgREST MCP server allows you to connect your own users to your app via REST API. See more details on its [project README](./packages/mcp-server-postgrest).

## Resources

- [**Model Context Protocol**](https://modelcontextprotocol.io/introduction): Learn more about MCP and its capabilities.
- [**From development to production**](/docs/production.md): Learn how to safely promote changes to production environments.

## For developers

See [CONTRIBUTING](./CONTRIBUTING.md) for details on how to contribute to this project.

## License

This project is licensed under Apache 2.0. See the [LICENSE](./LICENSE) file for details.
