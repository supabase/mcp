import { z } from 'zod/v4';

export const knowledgeBaseSearchResultSchema = z.object({
  title: z.string(),
  href: z.string(),
  heading: z.string().nullish(),
  excerpt: z.string().nullish(),
  score: z.number(),
});

export type KnowledgeBaseSearchResult = z.infer<
  typeof knowledgeBaseSearchResultSchema
>;

export type KnowledgeBaseClient = {
  search(params: {
    query: string;
    limit?: number;
  }): Promise<KnowledgeBaseSearchResult[]>;
};

/**
 * Client for the Knowledge Base search endpoint:
 * `GET <url>?q=<query>&limit=<n>` returns a JSON array of results.
 */
export function createKnowledgeBaseClient(
  url: string,
  headers?: Record<string, string>
): KnowledgeBaseClient {
  return {
    async search({ query, limit }) {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set('q', query);
      if (limit !== undefined) {
        requestUrl.searchParams.set('limit', String(limit));
      }

      const response = await fetch(requestUrl, {
        headers: { ...headers, Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(
          `Supabase Knowledge Base search failed: HTTP status ${response.status}`
        );
      }

      return z
        .array(knowledgeBaseSearchResultSchema)
        .parse(await response.json());
    },
  };
}
