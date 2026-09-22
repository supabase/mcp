import createClient, { type Client } from 'openapi-fetch';
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
