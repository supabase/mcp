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

export function createManagementApiClient(
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

export type ManagementApiClient = Client<paths>;

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

// The API prefixes validation errors with the field name, e.g. `ref: ref must be exactly 20 characters long`.
const malformedRefMessagePattern = /^ref: /;

/** A Management API failure that keeps its HTTP status, e.g. so callers can tell permission errors apart. */
export class ManagementApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

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
      throw new ManagementApiError(
        'Unauthorized. Please provide a valid access token to the MCP server via the --access-token flag or SUPABASE_ACCESS_TOKEN.',
        401
      );
    }

    const { data: errorContent } = errorSchema.safeParse(response.error);

    if (errorContent) {
      if (
        response.response.status === 400 &&
        malformedRefMessagePattern.test(errorContent.message)
      ) {
        throw new ManagementApiError(
          `${errorContent.message.replace(/\.$/, '')}. Copy the ref exactly as returned by list_projects (id) or list_branches (project_ref), depending on whether you're working with the main project or a branch; do not retype or shorten it.`,
          400
        );
      }

      throw new ManagementApiError(
        errorContent.message,
        response.response.status
      );
    }

    throw new ManagementApiError(fallbackMessage, response.response.status);
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

    throw new ManagementApiError(
      `${apiMessage}. Access to project '${projectId}' was denied. If this project exists, your access token may be scoped to a different organization: re-authenticate with the MCP server and select the organization that owns this project.`,
      403
    );
  }

  assertSuccess(response, fallbackMessage);
}
