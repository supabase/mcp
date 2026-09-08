import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  bearerAuthChallengeResponse,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  type Implementation,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isSpecType,
  localhostAllowedHostnames,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
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
  /**
   * Advertise this endpoint as an OAuth-protected resource (RFC 9728)
   * backed by this authorization server, so each connecting MCP client
   * signs in for itself instead of the client supplying a PAT. The server
   * never validates the token itself — same trust model as PAT mode, the
   * Management API is the authority, so an invalid or expired token
   * surfaces as a normal API error on the first tool call.
   */
  oauthAuthorizationServer?: URL;
  log?: (line: string) => void;
};

// Mirrors the hosted endpoint's advertised scopes (`mcp.supabase.com/.well-known/oauth-protected-resource/mcp`),
// so an OAuth client requests the same access the Management API tools need.
const OAUTH_SCOPES_SUPPORTED = [
  'organizations:read',
  'projects:read',
  'projects:write',
  'database:write',
  'database:read',
  'analytics:read',
  'secrets:read',
  'edge_functions:read',
  'edge_functions:write',
  'environment:read',
  'environment:write',
  'storage:read',
  'storage:write',
];

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
  oauthAuthorizationServer,
  log = (line) =>
    console.error(`[${new Date().toLocaleTimeString('en-GB')}] ${line}`),
}: LocalHttpEntryOptions) {
  const requestStateKey = randomBytes(32);
  const allowedHostnames = localhostAllowedHostnames();

  // The Host header is already validated against the localhost allowlist
  // above, so this reflects whichever of `127.0.0.1`/`localhost`/`[::1]`
  // the client actually dialed — required for the OAuth client's
  // same-origin check against the resource it discovered.
  function resourceUrl(request: Request): URL {
    const host = request.headers.get('host');
    if (!host) throw new Error('expected a validated Host header');
    return new URL(`http://${host}/mcp`);
  }

  const server = createServer(
    toNodeHandler(
      {
        fetch: async (request) => {
          const rejected =
            hostHeaderValidationResponse(request, allowedHostnames) ??
            originValidationResponse(request, []);
          if (rejected) return rejected;

          if (oauthAuthorizationServer) {
            const metadataPath = new URL(
              getOAuthProtectedResourceMetadataUrl(resourceUrl(request))
            ).pathname;
            if (new URL(request.url).pathname === metadataPath) {
              return Response.json({
                resource: resourceUrl(request).toString(),
                authorization_servers: [oauthAuthorizationServer.origin],
                scopes_supported: OAUTH_SCOPES_SUPPORTED,
              });
            }
          }

          const accessToken = request.headers
            .get('authorization')
            ?.match(/^Bearer (.+)$/i)?.[1];
          if (!accessToken) {
            if (oauthAuthorizationServer) {
              return bearerAuthChallengeResponse(
                new OAuthError(
                  OAuthErrorCode.InvalidToken,
                  'Missing Authorization header'
                ),
                {
                  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
                    resourceUrl(request)
                  ),
                }
              );
            }
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
                costConfirmation: {
                  requestStateKey,
                  principal: createHash('sha256')
                    .update(accessToken)
                    .digest('hex'),
                  enabledTools: ['create_project', 'create_branch'],
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
