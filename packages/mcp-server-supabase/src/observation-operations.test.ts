import {
  tools,
  setup,
  issued,
  decision,
  response,
  validation,
  started,
  operationEnd,
  assertAttempt,
  required,
} from './observation-test-helpers.js';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { describe, expect, test, vi } from 'vitest';
import * as pricing from './pricing.js';

test('platform rejection wins over an accepted response', async () => {
  const name = 'create_project';
  const h = await setup();
  const first = issued(await h.call(name));
  h.operation(name).mockRejectedValueOnce(new Error('PRIVATE_PLATFORM_ERROR'));
  const result = await h.call(name, {
    requestState: first.requestState,
    inputResponses: { confirm_cost: { action: 'accept', content: {} } },
  });
  expect((result as CallToolResult).isError).toBe(true);
  assertAttempt(
    h.attempts[1],
    name,
    [
      decision('inline', 'eligible'),
      response('accept'),
      validation('valid'),
      started,
      operationEnd('threw'),
    ],
    'tool_error'
  );
  expect(h.operation(name)).toHaveBeenCalledTimes(1);
});

describe.each(tools)('%s observation', (name) => {
  test('replaying accepted state counts independent attempts and repeated operations', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    const resume = {
      requestState: first.requestState,
      inputResponses: {
        confirm_cost: { action: 'accept' as const, content: {} },
      },
    };
    await h.call(name, resume);
    await h.call(name, resume);
    expect(h.attempts).toHaveLength(3);
    for (const attempt of h.attempts.slice(1))
      assertAttempt(
        attempt,
        name,
        [
          decision('inline', 'eligible'),
          response('accept'),
          validation('valid'),
          started,
          operationEnd('returned'),
        ],
        'completed'
      );
    expect(h.operation(name)).toHaveBeenCalledTimes(2);
  });
});

test('only an initial zero-cost project bypasses issuance; zero-cost branches still ask', async () => {
  const h = await setup();
  h.platform.account.listProjects.mockResolvedValue([]);
  expect(((await h.call('create_project')) as CallToolResult).isError).not.toBe(
    true
  );
  assertAttempt(
    h.attempts[0],
    'create_project',
    [decision('bypass', 'zero_cost'), started, operationEnd('returned')],
    'completed'
  );
  vi.spyOn(pricing, 'getBranchCost').mockReturnValue({
    type: 'branch',
    recurrence: 'hourly',
    amount: 0,
  });
  issued(await h.call('create_branch'));
  assertAttempt(
    h.attempts[1],
    'create_branch',
    [decision('inline', 'eligible'), required('initial')],
    'input_required'
  );
  expect(h.createProject).toHaveBeenCalledTimes(1);
  expect(h.createBranch).not.toHaveBeenCalled();
});

test('a quote lookup failure settles the attempt without inventing eligibility', async () => {
  const h = await setup();
  h.platform.account.getOrganization.mockRejectedValueOnce(
    new Error('PRIVATE_QUOTE_ERROR')
  );
  expect(((await h.call('create_project')) as CallToolResult).isError).toBe(
    true
  );
  assertAttempt(h.attempts[0], 'create_project', [], 'tool_error');
  expect(h.createProject).not.toHaveBeenCalled();
});
