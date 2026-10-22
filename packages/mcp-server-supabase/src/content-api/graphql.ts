import {
  buildSchema,
  GraphQLError,
  GraphQLSchema,
  parse,
  validate,
  type DocumentNode,
} from 'graphql';
import { z } from 'zod/v4';
import { ToolCallerError } from '../errors.js';

export const graphqlRequestSchema = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()).optional(),
});

export const graphqlErrorSchema = z.object({
  message: z.string(),
  locations: z.array(
    z.object({
      line: z.number(),
      column: z.number(),
    })
  ),
});

export const graphqlResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z.array(graphqlErrorSchema).optional(),
});

export type GraphQLRequest = z.infer<typeof graphqlRequestSchema>;
export type GraphQLResponse = z.infer<typeof graphqlResponseSchema>;

export type QueryFn = (
  request: GraphQLRequest
) => Promise<Record<string, unknown>>;

export type QueryOptions = {
  validateSchema?: boolean;
};

export type GraphQLClientOptions = {
  /**
   * The URL of the GraphQL endpoint.
   */
  url: string;

  /**
   * A function that loads the GraphQL schema.
   * This will be used for validating future queries.
   *
   * A `query` function is provided that can be used to
   * execute GraphQL queries against the endpoint
   * (e.g. if the API itself allows querying the schema).
   */
  loadSchema?({ query }: { query: QueryFn }): Promise<string>;

  /**
   * Optional headers to include in the request.
   */
  headers?: Record<string, string>;
};

export class GraphQLClient {
  #url: string;
  #headers: Record<string, string>;

  /**
   * A promise that resolves when the schema is loaded via
   * the `loadSchema` function.
   *
   * Resolves to an object containing the raw schema source
   * string and the parsed GraphQL schema.
   *
   * Rejects if no `loadSchema` function was provided to
   * the constructor.
   */
  schemaLoaded: Promise<{
    /**
     * The raw GraphQL schema string.
     */
    source: string;

    /**
     * The parsed GraphQL schema.
     */
    schema: GraphQLSchema;
  }>;

  /**
   * Creates a new GraphQL client.
   */
  constructor(options: GraphQLClientOptions) {
    this.#url = options.url;
    this.#headers = options.headers ?? {};

    this.schemaLoaded =
      options
        .loadSchema?.({ query: this.#query.bind(this) })
        .then((source) => ({
          source,
          schema: buildSchema(source),
        })) ?? Promise.reject(new Error('No schema loader provided'));

    // Prevent unhandled promise rejections
    this.schemaLoaded.catch(() => {});
  }

  /**
   * Executes a GraphQL query against the provided URL.
   */
  async query(
    request: GraphQLRequest,
    options: QueryOptions = { validateSchema: false }
  ) {
    let documentNode: DocumentNode;
    try {
      documentNode = parse(request.query);
    } catch (error) {
      if (error instanceof GraphQLError) {
        throw new ToolCallerError(`Invalid GraphQL query: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }

    if (options.validateSchema) {
      // Schema load failures are server faults, so they stay unbranded.
      const { schema } = await this.schemaLoaded;
      const errors = validate(schema, documentNode);
      if (errors.length > 0) {
        throw new ToolCallerError(
          `Invalid GraphQL query: ${errors.map((e) => e.message).join(', ')}`
        );
      }
    }

    return this.#query(request);
  }

  /**
   * Sets the User-Agent header for all requests.
   */
  setUserAgent(userAgent: string) {
    this.#headers['User-Agent'] = userAgent;
  }

  /**
   * Executes a GraphQL query against the provided URL.
   *
   * Does not validate the query against the schema.
   */
  async #query(request: GraphQLRequest) {
    const { query, variables } = request;

    const url = new URL(this.#url);

    url.searchParams.set('query', query);
    if (variables !== undefined) {
      url.searchParams.set('variables', JSON.stringify(variables));
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...this.#headers,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Supabase Content API GraphQL schema: HTTP status ${response.status}`
      );
    }

    const json = await response.json();

    const { data, error } = graphqlResponseSchema.safeParse(json);

    if (error) {
      throw new Error(
        `Failed to parse Supabase Content API response: ${error.message}`
      );
    }

    if (data.errors?.length) {
      throw new Error(
        `Supabase Content API GraphQL error: ${data.errors
          .map(
            (err) =>
              `${err.message} (line ${err.locations[0]?.line ?? 'unknown'}, column ${err.locations[0]?.column ?? 'unknown'})`
          )
          .join(', ')}`
      );
    }

    if (!data.data) {
      throw new Error('Supabase Content API returned no data');
    }

    return data.data;
  }
}

/**
 * Extracts the fields from a GraphQL query document.
 */
export function getQueryFields(document: DocumentNode) {
  return document.definitions
    .filter((def) => def.kind === 'OperationDefinition')
    .flatMap((def) => {
      if (def.kind === 'OperationDefinition' && def.selectionSet) {
        return def.selectionSet.selections
          .filter((sel) => sel.kind === 'Field')
          .map((sel) => {
            if (sel.kind === 'Field') {
              return sel.name.value;
            }
            return null;
          })
          .filter(Boolean);
      }
      return [];
    });
}
