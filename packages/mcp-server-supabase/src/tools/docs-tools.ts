import { tool } from '@supabase/mcp-utils';
import { source } from 'common-tags';
import { z } from 'zod/v4';
import type { ContentApiClient } from '../content-api/index.js';
import type { ToolDefs } from './util.js';

type DocsToolsOptions = {
  contentApiClient: ContentApiClient;
};

const searchDocsInputSchema = z.object({
  graphql_query: z.string().describe('GraphQL query string'),
});

const searchDocsOutputSchema = z.object({
  result: z.unknown().describe('GraphQL query result'),
});

export const docsToolDefs = {
  search_docs: {
    parameters: searchDocsInputSchema,
    outputSchema: searchDocsOutputSchema,
    annotations: {
      title: 'Search docs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getDocsTools({ contentApiClient }: DocsToolsOptions) {
  return {
    search_docs: tool({
      ...docsToolDefs.search_docs,
      description: async () => {
        const schema = await contentApiClient.loadSchema();

        return source`
          Search the Supabase documentation using GraphQL. Must be a valid GraphQL query that uses only the fields and arguments in the schema below; other fields, arguments or fragments fail.
          Example: \`{ searchDocs(query: "row level security", limit: 5) { nodes { title href content } } }\`
          You should default to calling this even if you think you already know the answer, since the documentation is always being updated.

          Below is the GraphQL schema for this tool:

          ${schema}
        `;
      },
      execute: async ({ graphql_query }) => {
        const result = await contentApiClient.query({ query: graphql_query });
        return { result };
      },
    }),
  };
}
