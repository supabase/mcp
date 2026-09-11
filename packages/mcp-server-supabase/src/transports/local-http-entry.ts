import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  hostHeaderValidationResponse,
  type Implementation,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isSpecType,
  localhostAllowedHostnames,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import { createSupabaseApiPlatform } from '../platform/api-platform.js';
import { createSupabaseMcpServer } from '../server.js';
import { parseFeatureGroups } from '../util.js';
import { parseList } from './util.js';

export type LocalHttpEntryOptions = {
  port: number;
  apiUrl?: string;
  contentApiUrl?: string;
  log?: (line: string) => void;
};

// https://supabase.com/docs/guides/ai-tools/mcp#configuration-options
const querySchema = z.object({
  project_ref: z.string().optional(),
  read_only: z.stringbool().default(false),
  features: z
    .string()
    .transform((value) => parseList(value))
    .optional(),
});

/** e.g. `tools/call create_branch  claude-code/2.1.260  (2026-07-28)` */
export function describeRequest(body: unknown): string {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  let client: Implementation | undefined;
  let method: string | undefined;
  let protocolVersion: string | undefined;
  for (const message of messages) {
    if (!isJSONRPCRequest(message) && !isJSONRPCNotification(message)) continue;
    method ??= isSpecType.CallToolRequest(message)
      ? `${message.method} ${message.params.name}`
      : message.method;
    const meta = message.params?._meta;
    const metaClient = meta?.[CLIENT_INFO_META_KEY];
    if (isSpecType.Implementation(metaClient)) client ??= metaClient;
    const metaVersion = meta?.[PROTOCOL_VERSION_META_KEY];
    if (typeof metaVersion === 'string') protocolVersion ??= metaVersion;
    if (isSpecType.InitializeRequest(message)) {
      client ??= message.params.clientInfo;
      protocolVersion ??= message.params.protocolVersion;
    }
  }
  const name = client
    ? [client.name, client.version].filter(Boolean).join('/')
    : 'unknown';
  return [
    (method ?? 'unknown').padEnd(28),
    name.padEnd(24),
    `(${protocolVersion ?? 'legacy'})`,
  ].join('  ');
}

export async function startLocalHttpEntry({
  port,
  apiUrl,
  contentApiUrl,
  log = (line) =>
    console.error(`[${new Date().toLocaleTimeString('en-GB')}] ${line}`),
}: LocalHttpEntryOptions) {
  const requestStateKey = randomBytes(32);
  const allowedHostnames = localhostAllowedHostnames();

  const server = createServer(
    toNodeHandler(
      {
        fetch: async (request) => {
          const rejected = hostHeaderValidationResponse(
            request,
            allowedHostnames
          );
          if (rejected) return rejected;

          const accessToken = request.headers
            .get('authorization')
            ?.match(/^Bearer (.+)$/i)?.[1];
          if (!accessToken) {
            return Response.json(
              { error: 'missing bearer token' },
              { status: 401 }
            );
          }

          const url = new URL(request.url);
          const query = querySchema.safeParse(
            Object.fromEntries(url.searchParams)
          );
          if (!query.success) {
            return Response.json(
              { error: z.prettifyError(query.error) },
              { status: 400 }
            );
          }
          const {
            project_ref: projectId,
            read_only: readOnly,
            features,
          } = query.data;

          log(
            describeRequest(
              await request
                .clone()
                .json()
                .catch(() => undefined)
            )
          );

          const platform = createSupabaseApiPlatform({ accessToken, apiUrl });
          if (features) parseFeatureGroups(platform, features);
          const handler = createMcpHandler(
            () =>
              createSupabaseMcpServer({
                platform,
                projectId,
                readOnly,
                features,
                contentApiUrl,
                confirmation: {
                  requestStateKey,
                  // One process can serve several PATs, so the principal is the token's hash.
                  principal: createHash('sha256')
                    .update(accessToken)
                    .digest('hex'),
                  enabledTools: [
                    'create_project',
                    'create_branch',
                    'execute_sql',
                    'apply_migration',
                  ],
                },
              }),
            { legacy: 'stateless', onerror: console.error }
          );
          request.signal.addEventListener('abort', () => handler.close(), {
            once: true,
          });
          return handler.fetch(request);
        },
      },
      { onerror: console.error }
    )
  );

  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
    },
  };
}

export type LocalHttpEntry = Awaited<ReturnType<typeof startLocalHttpEntry>>;
