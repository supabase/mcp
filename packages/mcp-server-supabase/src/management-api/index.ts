import createClient, {
  type Client,
  type FetchResponse,
  type ParseAsResponse,
} from 'openapi-fetch';
import type {
  MediaType,
  ResponseObjectMap,
  SuccessResponse,
} from 'openapi-typescript-helpers';
import { z } from 'zod/v4';
import type { paths } from './types.js';
import type { WarehousePaths } from '../platform/warehouse.js';

type ManagementApiPaths = paths & WarehousePaths;

export function createManagementApiClient(
  baseUrl: string,
  accessToken: string,
  headers: Record<string, string> = {}
) {
  return createClient<ManagementApiPaths>({
    baseUrl,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...headers,
    },
  });
}

export type ManagementApiClient = Client<ManagementApiPaths>;

export type SuccessResponseType<
  T extends Record<string | number, any>,
  Options,
  Media extends MediaType,
> = {
  data: ParseAsResponse<SuccessResponse<ResponseObjectMap<T>, Media>, Options>;
  error?: never;
  response: Response;
};

const errorSchema = z.object({
  message: z.string(),
});

export function assertSuccess<
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
      throw new Error(errorContent.message);
    }

    throw new Error(fallbackMessage);
  }
}

/**
 * Asserts success for project-scoped endpoints, mapping 403 responses to an
 * actionable message. A permission error on a specific project most commonly
 * means the access token is scoped to an organization that doesn't own the
 * project (e.g. the wrong organization was selected during OAuth login).
 *
 * Currently applied only to database operations (see AI-178). Before adopting
 * for other endpoints, check that a 403 there isn't better explained by plan
 * or role restrictions, where org-selection advice would mislead.
 */
export function assertProjectScopedSuccess<
  T extends Record<string | number, any>,
  Options,
  Media extends MediaType,
>(
  response: FetchResponse<T, Options, Media>,
  fallbackMessage: string,
  projectId: string
): asserts response is SuccessResponseType<T, Options, Media> {
  if ('error' in response && response.response.status === 403) {
    const { data: errorContent } = errorSchema.safeParse(response.error);
    const apiMessage = (errorContent?.message ?? fallbackMessage).replace(
      /\.$/,
      ''
    );

    throw new Error(
      `${apiMessage}. Access to project '${projectId}' was denied. If this project exists, your access token may be scoped to a different organization: re-authenticate with the MCP server and select the organization that owns this project.`
    );
  }

  assertSuccess(response, fallbackMessage);
}
