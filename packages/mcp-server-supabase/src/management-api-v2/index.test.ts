import { afterEach, describe, expect, test, vi } from 'vitest';
import { createManagementApiV2Client } from './index.js';

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
