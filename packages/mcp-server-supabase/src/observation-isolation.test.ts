import { setup, issued, form } from './observation-test-helpers.js';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { expect, test, vi } from 'vitest';
import type { RequestObserver } from './index.js';

test('record throws and end rejects preserve platform return/error and onToolCall', async () => {
  const onToolCall = vi.fn();
  const observer: RequestObserver = () => ({
    record() {
      throw new Error('PRIVATE_SINK_ERROR');
    },
    end() {
      return Promise.reject(new Error('PRIVATE_SINK_REJECTION'));
    },
  });
  const h = await setup({ observer, onToolCall });
  h.platform.account.listProjects.mockResolvedValue([]);
  const success = await h.call('create_project');
  expect((success as CallToolResult).isError).not.toBe(true);
  expect((success as CallToolResult).content).toEqual([
    { type: 'text', text: JSON.stringify(h.project) },
  ]);
  h.createProject.mockRejectedValueOnce(new Error('PRIVATE_BUSINESS_ERROR'));
  const failureResult = await h.call('create_project');
  expect((failureResult as CallToolResult).isError).toBe(true);
  expect(JSON.stringify(failureResult)).toContain('PRIVATE_BUSINESS_ERROR');
  expect(h.createProject).toHaveBeenCalledTimes(2);
  expect(onToolCall).toHaveBeenCalledTimes(2);
  expect(onToolCall.mock.calls[0]![0]).toMatchObject({
    name: 'create_project',
    arguments: h.args('create_project'),
    success: true,
    data: h.project,
  });
  expect(onToolCall.mock.calls[1]![0]).toMatchObject({
    name: 'create_project',
    arguments: h.args('create_project'),
    success: false,
    error: expect.objectContaining({ message: 'PRIVATE_BUSINESS_ERROR' }),
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
});

test('observer DTOs have closed keys and exclude arguments, state, URLs, results and errors', async () => {
  const h = await setup();
  const first = issued(
    await h.call('create_project', {
      arguments: {
        ...h.args('create_project'),
        name: 'PRIVATE_SQL SELECT secret',
      },
      _meta: {
        private: 'PRIVATE_META',
        [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
        [CLIENT_CAPABILITIES_META_KEY]: form,
      },
    })
  );
  h.createProject.mockRejectedValueOnce(
    new Error('PRIVATE_ERROR https://PRIVATE_ERROR_URL.test')
  );
  await h.call('create_project', {
    requestState: first.requestState,
    arguments: {
      ...h.args('create_project'),
      name: 'PRIVATE_SQL SELECT secret',
    },
    inputResponses: { confirm_cost: { action: 'accept', content: {} } },
  });
  expect(JSON.stringify(h.attempts)).not.toContain('PRIVATE_');
  expect(JSON.stringify(h.attempts)).not.toContain(first.requestState);
  const keys = {
    confirmation_decision: ['feature', 'kind', 'reason', 'route'],
    input_required: ['feature', 'kind', 'mode', 'reason'],
    input_response: ['action', 'feature', 'kind'],
    resume_validation: ['feature', 'kind', 'result'],
    operation: ['disposition', 'feature', 'kind'],
  };
  for (const attempt of h.attempts) {
    expect(Object.keys(attempt.context).sort()).toEqual(['method', 'tool']);
    for (const fact of attempt.facts)
      expect(Object.keys(fact).sort()).toEqual(
        [
          ...keys[fact.kind],
          ...('durationMs' in fact ? ['durationMs'] : []),
        ].sort()
      );
    for (const end of attempt.ends)
      expect(Object.keys(end).sort()).toEqual(['durationMs', 'result']);
  }
});
