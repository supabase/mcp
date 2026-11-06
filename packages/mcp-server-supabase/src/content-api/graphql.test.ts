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

  it('surfaces Content API errors without locations', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [
            {
              message:
                'Must provide operation name if query contains multiple operations.',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
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
        'Supabase Content API GraphQL error: Must provide operation name if query contains multiple operations.',
    });
    expect(isToolCallerError(error)).toBe(false);
  });

  it('includes the location when the Content API provides one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [
            {
              message: 'Cannot query field "foo".',
              locations: [{ line: 2, column: 3 }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
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
        'Supabase Content API GraphQL error: Cannot query field "foo". (line 2, column 3)',
    });
    expect(isToolCallerError(error)).toBe(false);
  });
});
