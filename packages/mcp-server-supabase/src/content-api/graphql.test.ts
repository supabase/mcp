import { stripIndent } from 'common-tags';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isToolCallerError } from '../errors.js';
import { GraphQLClient } from './graphql.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('graphql client', () => {
  it('should load schema', async () => {
    const schema = stripIndent`
      schema {
        query: RootQueryType
      }
      type RootQueryType {
        message: String!
      }
    `;

    const graphqlClient = new GraphQLClient({
      url: 'dummy-url',
      loadSchema: async () => schema,
    });

    const { source } = await graphqlClient.schemaLoaded;

    expect(source).toBe(schema);
  });

  it('should throw error if validation requested but loadSchema not provided', async () => {
    const graphqlClient = new GraphQLClient({
      url: 'dummy-url',
    });

    await expect(
      graphqlClient.query(
        { query: '{ getHelloWorld }' },
        { validateSchema: true }
      )
    ).rejects.toThrow('No schema loader provided');
  });

  it('should throw for invalid query regardless of schema', async () => {
    const graphqlClient = new GraphQLClient({
      url: 'dummy-url',
    });

    await expect(
      graphqlClient.query({ query: 'invalid graphql query' })
    ).rejects.toMatchObject({
      name: 'ToolCallerError',
      message:
        'Invalid GraphQL query: Syntax Error: Unexpected Name "invalid".',
    });
  });

  it("should throw error if query doesn't match schema", async () => {
    const schema = stripIndent`
      schema {
        query: RootQueryType
      }
      type RootQueryType {
        message: String!
      }
    `;

    const graphqlClient = new GraphQLClient({
      url: 'dummy-url',
      loadSchema: async () => schema,
    });

    await expect(
      graphqlClient.query(
        { query: '{ invalidField }' },
        { validateSchema: true }
      )
    ).rejects.toMatchObject({
      name: 'ToolCallerError',
      message:
        'Invalid GraphQL query: Cannot query field "invalidField" on type "RootQueryType".',
    });
  });

  it('bubbles up loadSchema errors', async () => {
    const graphqlClient = new GraphQLClient({
      url: 'dummy-url',
      loadSchema: async () => {
        throw new Error('Failed to load schema');
      },
    });

    await expect(graphqlClient.schemaLoaded).rejects.toThrow(
      'Failed to load schema'
    );
  });

  it('keeps malformed server schema errors unbranded', async () => {
    const graphqlClient = new GraphQLClient({
      url: 'dummy-url',
      loadSchema: async () => 'type Query {',
    });

    const error = await graphqlClient
      .query({ query: '{ getHelloWorld }' }, { validateSchema: true })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect(isToolCallerError(error)).toBe(false);
  });

  it('keeps Content API failures as plain errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 })
    );
    const graphqlClient = new GraphQLClient({
      url: 'https://content.example.com/graphql',
    });

    const error = await graphqlClient
      .query({ query: '{ getHelloWorld }' })
      .catch((error: unknown) => error);

    expect(error).toMatchObject({
      name: 'Error',
      message:
        'Failed to fetch Supabase Content API GraphQL schema: HTTP status 503',
    });
    expect(isToolCallerError(error)).toBe(false);
  });

  it('reports GraphQL errors the Content API returns for a query as caller errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: null,
        errors: [
          {
            message: 'Cannot query field "nope" on type "Query".',
            locations: [{ line: 1, column: 3 }],
          },
        ],
      })
    );
    const graphqlClient = new GraphQLClient({
      url: 'https://content.example.com/graphql',
    });

    const error = await graphqlClient
      .query({ query: '{ nope }' })
      .catch((error: unknown) => error);

    expect(error).toMatchObject({
      message:
        'Supabase Content API GraphQL error: Cannot query field "nope" on type "Query". (line 1, column 3)',
    });
    expect(isToolCallerError(error)).toBe(true);
  });

  it('keeps located GraphQL execution errors from the Content API as server faults', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: null,
        errors: [
          {
            message: 'Internal Server Error',
            locations: [{ line: 1, column: 3 }],
            path: ['searchDocs'],
          },
        ],
      })
    );
    const graphqlClient = new GraphQLClient({
      url: 'https://content.example.com/graphql',
    });

    const error = await graphqlClient
      .query({ query: '{ searchDocs(query: "auth") { nodes { title } } }' })
      .catch((error: unknown) => error);

    expect(error).toMatchObject({
      message:
        'Supabase Content API GraphQL error: Internal Server Error (line 1, column 3)',
    });
    expect(isToolCallerError(error)).toBe(false);
  });

  it.each([
    [
      {
        message: 'Cannot query field "nope" on type "RootQueryType".',
        locations: [{ line: 1, column: 3 }],
      },
      'Supabase Content API GraphQL error: Cannot query field "nope" on type "RootQueryType". (line 1, column 3)',
    ],
    [
      {
        message:
          'GET requests must specify an operation name or send only a single operation',
      },
      'Supabase Content API GraphQL error: GET requests must specify an operation name or send only a single operation',
    ],
  ])(
    'reports the Content API GraphQL error message: %j',
    async (graphqlError, message) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({ errors: [graphqlError] })
      );
      const graphqlClient = new GraphQLClient({
        url: 'https://content.example.com/graphql',
      });

      await expect(
        graphqlClient.query({ query: '{ getHelloWorld }' })
      ).rejects.toMatchObject({ message });
    }
  );
});
