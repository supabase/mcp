import { tool } from '@supabase/mcp-utils';
import { source } from 'common-tags';
import { z } from 'zod/v4';
import type { ContentApiClient } from '../content-api/index.js';
import {
  type KnowledgeBaseClient,
  knowledgeBaseSearchResultSchema,
} from '../content-api/knowledge-base.js';
import type { ToolDefs } from './util.js';

type DocsToolsOptions = {
  contentApiClient: ContentApiClient;
  knowledgeBaseClient: KnowledgeBaseClient;
};

const searchDocsInputSchema = z.object({
  graphql_query: z.string().describe('GraphQL query string'),
});

const searchDocsOutputSchema = z.object({
  result: z.unknown().describe('GraphQL query result'),
});

const searchKnowledgeBaseInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Key search terms, such as an error message, error code or product name'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Maximum number of results to return. Defaults to 10.'),
});

const searchKnowledgeBaseOutputSchema = z.object({
  results: z
    .array(knowledgeBaseSearchResultSchema)
    .describe('Matching Knowledge Base articles, best match first'),
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
  search_knowledge_base: {
    parameters: searchKnowledgeBaseInputSchema,
    outputSchema: searchKnowledgeBaseOutputSchema,
    annotations: {
      title: 'Search knowledge base',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getDocsTools({
  contentApiClient,
  knowledgeBaseClient,
}: DocsToolsOptions) {
  return {
    search_docs: tool({
      ...docsToolDefs.search_docs,
      description: async () => {
        const schema = await contentApiClient.loadSchema();

        return source`
          Search the Supabase documentation using GraphQL. Must be a valid GraphQL query.
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
    search_knowledge_base: tool({
      ...docsToolDefs.search_knowledge_base,
      description: source`
        Search the Supabase Knowledge Base for troubleshooting articles: known errors, their causes and how to fix them.
        Use this when the user hits an error message or unexpected behavior. Pass the key terms (error codes, messages, product names) as the query, not a full sentence.
        Each result links to an article. Append ".md" to a result's href to read the full article as Markdown.
      `,
      execute: async ({ query, limit }) => {
        const results = await knowledgeBaseClient.search({ query, limit });
        return { results };
      },
    }),
  };
}
