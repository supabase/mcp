import { ToolCallerError } from '@supabase/mcp-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { UNAUTHORIZED_MESSAGE } from '../management-api/index.js';
import { assertSuccessV2, createManagementApiV2Client } from './index.js';

describe('createManagementApiV2Client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('sends bearer authentication and custom headers', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);

    const client = createManagementApiV2Client(
      'https://api.example.com',
      'access-token',
      { 'User-Agent': 'test-client/1.0.0' }
    );

    await client.POST('/v2/projects/{ref}/advisors/run', {
      params: { path: { ref: 'project-ref' } },
      body: {
        data: {
          type: 'project_advisors',
          attributes: { lints: [{ name: 'instance_db_down' }] },
        },
      },
    });

    const [request] = fetch.mock.calls[0] as [Request];

    expect(request.url).toBe(
      'https://api.example.com/v2/projects/project-ref/advisors/run'
    );
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe('Bearer access-token');
    expect(request.headers.get('user-agent')).toBe('test-client/1.0.0');
    await expect(request.json()).resolves.toEqual({
      data: {
        type: 'project_advisors',
        attributes: { lints: [{ name: 'instance_db_down' }] },
      },
    });
  });
});

describe('assertSuccessV2', () => {
  test('a 401 names the token sources for both transports', () => {
    // Only `error` and `response.status` matter to assertSuccessV2.
    const response = {
      error: { error: { message: 'Unauthorized' } },
      response: new Response(null, { status: 401 }),
    } as never;

    let error: unknown;
    try {
      assertSuccessV2(response, 'Failed to list notebooks');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const { message, name } = error as Error;
    expect(message).toBe(UNAUTHORIZED_MESSAGE);
    expect(message).toMatch(
      /^Unauthorized\. Please provide a valid access token/
    );
    expect(message).toContain('"Authorization: Bearer <token>" header');
    expect(message).toContain('SUPABASE_ACCESS_TOKEN');
    // A 401 stays a plain Error rather than a caller error.
    expect(error).not.toBeInstanceOf(ToolCallerError);
    expect(name).toBe('Error');
  });
});
