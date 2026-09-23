import {
  createTtlCache,
  DEFAULT_CACHE_TTL_MS,
  type TtlCache,
} from '@supabase/mcp-utils';
import gqlmin from 'gqlmin';
import { z } from 'zod/v4';
import { GraphQLClient, type GraphQLRequest, type QueryFn } from './graphql.js';

const contentApiSchemaResponseSchema = z.object({
  schema: z.string(),
});

/**
 * How long a fetched Content API schema is served before it is re-fetched.
 * Also the `ttlMs` freshness hint on `tools/list`, since the schema is the
 * only part of the tool list that changes over time.
 */
export const CONTENT_API_SCHEMA_TTL_MS = DEFAULT_CACHE_TTL_MS;

/**
 * Process-wide schema caches, keyed by Content API URL.
 *
 * These deliberately outlive any one client: in the hosted deployment the
 * server (and with it the content API client) is created per request, so a
 * cache held by the client would be scoped to a single request and the
 * schema would be fetched on every `tools/list`.
 */
const schemaCaches = new Map<string, TtlCache<string>>();

/**
 * Returns the process-wide schema cache for `url`, creating it on first use.
 * The loader stays bound to whichever client first asked for this URL; later
 * clients for the same URL share its cached schema.
 */
function getSchemaCache(
  url: string,
  load: () => Promise<string>
): TtlCache<string> {
  let cache = schemaCaches.get(url);
  if (!cache) {
    cache = createTtlCache({ load, ttlMs: CONTENT_API_SCHEMA_TTL_MS });
    schemaCaches.set(url, cache);
  }
  return cache;
}

/** Drops every cached Content API schema so the next load re-fetches. */
export function invalidateContentApiSchemaCache(): void {
  for (const cache of schemaCaches.values()) {
    cache.invalidate();
  }
}

export type ContentApiClient = {
  loadSchema: () => Promise<string>;
  query: QueryFn;
  setUserAgent: (userAgent: string) => void;
};

export async function createContentApiClient(
  url: string,
  headers?: Record<string, string>
): Promise<ContentApiClient> {
  const graphqlClient = new GraphQLClient({
    url,
    headers,
  });

  // Content API provides schema string via `schema` query
  async function fetchSchema() {
    const response = await graphqlClient.query({ query: '{ schema }' });
    const { schema } = contentApiSchemaResponseSchema.parse(response);
    const minifiedSchema = gqlmin(schema);
    return minifiedSchema;
  }

  const schemaCache = getSchemaCache(url, fetchSchema);

  return {
    loadSchema: () => schemaCache.get(),
    async query(request: GraphQLRequest) {
      return graphqlClient.query(request);
    },
    setUserAgent(userAgent: string) {
      graphqlClient.setUserAgent(userAgent);
    },
  };
}
