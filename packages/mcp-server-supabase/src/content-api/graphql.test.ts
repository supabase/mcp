import { stripIndent } from 'common-tags';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isToolCallerError } from '@supabase/mcp-utils';
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

  it.each([
    [
      [
        {
          message: 'Cannot query field "nope" on type "RootQueryType".',
          locations: [{ line: 1, column: 3 }],
        },
      ],
      'Supabase Content API GraphQL error: Cannot query field "nope" on type "RootQueryType". (line 1, column 3)',
      true,
    ],
    [
      [
        {
          message:
            'GET requests must specify an operation name or send only a single operation',
        },
      ],
      'Supabase Content API GraphQL error: GET requests must specify an operation name or send only a single operation',
      true,
    ],
    [
      [
        {
          message: 'Internal Server Error',
          locations: [{ line: 1, column: 3 }],
          path: ['searchDocs'],
        },
      ],
      'Supabase Content API GraphQL error: Internal Server Error (line 1, column 3)',
      false,
    ],
    [
      [
        {
          message: 'Cannot query field "nope" on type "RootQueryType".',
          locations: [{ line: 1, column: 3 }],
        },
        {
          message: 'Internal Server Error',
          locations: [{ line: 2, column: 3 }],
          path: ['searchDocs'],
        },
      ],
      'Supabase Content API GraphQL error: Cannot query field "nope" on type "RootQueryType". (line 1, column 3), Internal Server Error (line 2, column 3)',
      false,
    ],
  ])(
    'reports the Content API GraphQL errors %j',
    async (graphqlErrors, message, callerError) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({ errors: graphqlErrors })
      );
      const graphqlClient = new GraphQLClient({
        url: 'https://content.example.com/graphql',
      });

      const error = await graphqlClient
        .query({ query: '{ getHelloWorld }' })
        .catch((error: unknown) => error);

      expect(error).toMatchObject({ message });
      expect(isToolCallerError(error)).toBe(callerError);
    }
  );
});
