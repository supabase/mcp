import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSupabaseApiPlatform } from './api-platform.js';
import { createFeedbackOperations } from './feedback.js';

describe('createFeedbackOperations', () => {
  test('submit posts to the RPC and returns the delete token', async () => {
    const token = '5d6d3b3e-4b2f-4a52-9b77-0f0e6a4f6a11';
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(token));
    const feedback = createFeedbackOperations({ fetch: fakeFetch });

    const result = await feedback.submit({
      feedback: 'Missing a tool',
      projectId: 'abc',
    });

    expect(result).toEqual({ deleteToken: token });
    expect(String(fakeFetch.mock.calls[0]![0])).toMatch(
      /\/rest\/v1\/rpc\/submit_interfaces_feedback$/
    );
    expect(JSON.parse(String(fakeFetch.mock.calls[0]![1]?.body))).toMatchObject(
      {
        feedback: 'Missing a tool',
        project_ref: 'abc',
        metadata: { source: 'mcp' },
      }
    );
  });

  test('submit adds client info to metadata when available', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json('tok'));
    const feedback = createFeedbackOperations({ fetch: fakeFetch });

    await feedback.submit({
      feedback: 'hi',
      clientInfo: { name: 'claude-code', version: '1.2.3' },
    });

    expect(
      JSON.parse(String(fakeFetch.mock.calls[0]![1]?.body)).metadata
    ).toEqual({
      source: 'mcp',
      client_name: 'claude-code',
      client_version: '1.2.3',
    });
  });

  test('submit omits client info when unavailable', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json('tok'));
    const feedback = createFeedbackOperations({ fetch: fakeFetch });

    await feedback.submit({ feedback: 'hi' });

    expect(
      JSON.parse(String(fakeFetch.mock.calls[0]![1]?.body)).metadata
    ).toEqual({
      source: 'mcp',
    });
  });

  test('submit includes the user id and delete sends it as a header', async () => {
    const submitFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json('tok'));
    const deleteFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 204, headers: { 'Content-Range': '*/1' } })
      );
    const getUserId = async () => 'user-1';

    await createFeedbackOperations({
      fetch: submitFetch,
      getUserId,
    }).submit({ feedback: 'hi' });
    await createFeedbackOperations({
      fetch: deleteFetch,
      getUserId,
    }).delete({ deleteToken: 'tok' });

    expect(
      JSON.parse(String(submitFetch.mock.calls[0]![1]?.body)).user_id
    ).toBe('user-1');
    expect(deleteFetch.mock.calls[0]![1]?.headers).toMatchObject({
      'x-feedback-user-id': 'user-1',
    });
  });

  test('submit still sends when the user id lookup fails', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json('tok'));
    const feedback = createFeedbackOperations({
      fetch: fakeFetch,
      getUserId: async () => {
        throw new Error('profile unavailable');
      },
    });

    await feedback.submit({ feedback: 'hi' });

    expect(
      JSON.parse(String(fakeFetch.mock.calls[0]![1]?.body)).user_id
    ).toBeUndefined();
  });

  test('submit rejects when the backend returns an error', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('boom', { status: 500 }));
    const feedback = createFeedbackOperations({ fetch: fakeFetch });

    await expect(feedback.submit({ feedback: 'hi' })).rejects.toThrow(
      'Failed to submit feedback: 500 boom'
    );
  });

  test('submit rejects when no delete token comes back', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(null));
    const feedback = createFeedbackOperations({ fetch: fakeFetch });

    await expect(feedback.submit({ feedback: 'hi' })).rejects.toThrow(
      'no delete token returned'
    );
  });

  test('delete rejects when the backend returns an error', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('denied', { status: 403 }));
    const feedback = createFeedbackOperations({ fetch: fakeFetch });

    await expect(feedback.delete({ deleteToken: 'tok' })).rejects.toThrow(
      'Failed to delete feedback: 403 denied'
    );
  });

  test('delete sends the token headers and reads the row count', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 204, headers: { 'Content-Range': '*/1' } })
      );
    const feedback = createFeedbackOperations({ fetch: fakeFetch });

    const result = await feedback.delete({
      deleteToken: 'tok',
      projectId: 'abc',
    });

    expect(result).toEqual({ deleted: true });
    expect(fakeFetch.mock.calls[0]![1]?.headers).toMatchObject({
      'x-feedback-token': 'tok',
      'x-feedback-project-ref': 'abc',
    });
  });

  test('delete reports false when no row matched', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 204, headers: { 'Content-Range': '*/0' } })
      );
    const feedback = createFeedbackOperations({ fetch: fakeFetch });

    expect(await feedback.delete({ deleteToken: 'tok' })).toEqual({
      deleted: false,
    });
  });
});

describe('API platform feedback environment', () => {
  afterEach(() => vi.restoreAllMocks());

  test.each([
    [undefined, 'xguihxuzqibwxjnimxev'],
    ['https://api.supabase.com', 'xguihxuzqibwxjnimxev'],
    ['https://api.supabase.green', 'actixlblmrqglneypada'],
    ['http://localhost:8080', 'actixlblmrqglneypada'],
  ])('apiUrl %s sends feedback to %s', async (apiUrl, projectRef) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json('tok'));
    const platform = createSupabaseApiPlatform({ accessToken: 'x', apiUrl });

    await platform.feedback!.submit({ feedback: 'hi' });

    const feedbackCall = fetchSpy.mock.calls.find(([input]) =>
      String(input instanceof Request ? input.url : input).includes(
        'submit_interfaces_feedback'
      )
    );
    expect(String(feedbackCall![0])).toContain(projectRef);
  });
});

describe('API platform user id', () => {
  afterEach(() => vi.restoreAllMocks());

  test('feedback includes the gotrue id header, even when the profile is forbidden', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        return url.includes('/v1/profile')
          ? Response.json(
              { message: 'This endpoint requires a user-scoped access token' },
              { status: 403, headers: { 'X-Gotrue-Id': 'user-1' } }
            )
          : Response.json('tok');
      });
    const platform = createSupabaseApiPlatform({ accessToken: 'x' });

    await platform.feedback!.submit({ feedback: 'hi' });

    const feedbackCall = fetchSpy.mock.calls.find(([input]) =>
      String(input instanceof Request ? input.url : input).includes(
        'submit_interfaces_feedback'
      )
    );
    expect(JSON.parse(String(feedbackCall![1]!.body)).user_id).toBe('user-1');
  });
});

describe('API platform user id timeout', () => {
  afterEach(() => vi.restoreAllMocks());

  test('feedback still sends when the profile lookup times out', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        if (input instanceof Request && input.url.includes('/v1/profile')) {
          input.signal.throwIfAborted();
          return Response.json({}, { headers: { 'X-Gotrue-Id': 'user-1' } });
        }
        return Response.json('tok');
      });
    const platform = createSupabaseApiPlatform({ accessToken: 'x' });

    await platform.feedback!.submit({ feedback: 'hi' });

    const feedbackCall = fetchSpy.mock.calls.find(([input]) =>
      String(input instanceof Request ? input.url : input).includes(
        'submit_interfaces_feedback'
      )
    );
    expect(JSON.parse(String(feedbackCall![1]!.body)).user_id).toBeUndefined();
  });
});
