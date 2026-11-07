import { describe, expect, test } from 'vitest';
import { createSupabaseApiPlatform } from './api-platform.js';

describe('getProjectUrl', () => {
  test('a local API URL is the project URL', async () => {
    const platform = createSupabaseApiPlatform({
      accessToken: 'local',
      apiUrl: 'http://127.0.0.1:54321',
    });
    expect(await platform.development!.getProjectUrl('default')).toBe(
      'http://127.0.0.1:54321'
    );
  });

  test('the hosted API URL maps to the project subdomain', async () => {
    const platform = createSupabaseApiPlatform({ accessToken: 'token' });
    expect(await platform.development!.getProjectUrl('abc')).toBe(
      'https://abc.supabase.co'
    );
  });
});
