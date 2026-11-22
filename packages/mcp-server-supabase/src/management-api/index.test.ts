import { ToolCallerError } from '@supabase/mcp-utils';
import { describe, expect, test } from 'vitest';
import { assertSuccess, UNAUTHORIZED_MESSAGE } from './index.js';

function errorResponse(status: number, error: unknown) {
  // Only `error` and `response.status` matter to assertSuccess.
  return { error, response: new Response(null, { status }) } as never;
}

function thrownBy(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected a throw');
}

describe('assertSuccess', () => {
  test('a 401 names the token sources for both transports', () => {
    const error = thrownBy(() =>
      assertSuccess(
        errorResponse(401, { message: 'Unauthorized' }),
        'Failed to list storage buckets'
      )
    );

    expect(error.message).toBe(UNAUTHORIZED_MESSAGE);
    expect(error.message).toMatch(
      /^Unauthorized\. Please provide a valid access token/
    );
    expect(error.message).toContain('"Authorization: Bearer <token>" header');
    expect(error.message).toContain('--access-token');
    expect(error.message).toContain('SUPABASE_ACCESS_TOKEN');
    // A 401 stays a plain Error rather than a caller error.
    expect(error).not.toBeInstanceOf(ToolCallerError);
    expect(error.name).toBe('Error');
  });
});
