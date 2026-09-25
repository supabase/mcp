import createClient, {
  type Client,
  type FetchResponse,
  type ParseAsResponse,
} from 'openapi-fetch';
import type {
  MediaType,
  ResponseObjectMap,
  SuccessResponse as OpenApiSuccessResponse,
} from 'openapi-typescript-helpers';
import { z } from 'zod/v4';
import type { paths } from './types.js';

export function createManagementApiV2Client(
  baseUrl: string,
  accessToken: string,
  headers: Record<string, string> = {}
) {
  return createClient<paths>({
    baseUrl,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...headers,
    },
  });
}

export type ManagementApiV2Client = Client<paths>;

type SuccessResponseType<
  T extends Record<string | number, any>,
  Options,
  Media extends MediaType,
> = {
  data: ParseAsResponse<
    OpenApiSuccessResponse<ResponseObjectMap<T>, Media>,
    Options
  >;
  error?: never;
  response: Response;
};

const errorSchema = z.object({
  error: z.object({
    message: z.string(),
  }),
});

/**
 * Asserts success for v2 (JSON:API-style) endpoints. Error bodies here are
 * shaped as `{ error: { message, code, ... } }`, unlike v1's flat
 * `{ message }` — so this can't reuse `assertSuccess` from `management-api`.
 */
export function assertSuccessV2<
  T extends Record<string | number, any>,
  Options,
  Media extends MediaType,
>(
  response: FetchResponse<T, Options, Media>,
  fallbackMessage: string
): asserts response is SuccessResponseType<T, Options, Media> {
  if ('error' in response) {
    if (response.response.status === 401) {
      throw new Error(
        'Unauthorized. Please provide a valid access token to the MCP server via the --access-token flag or SUPABASE_ACCESS_TOKEN.'
      );
    }

    const { data: errorContent } = errorSchema.safeParse(response.error);

    if (errorContent) {
      throw new Error(errorContent.error.message);
    }

    throw new Error(fallbackMessage);
  }
}
