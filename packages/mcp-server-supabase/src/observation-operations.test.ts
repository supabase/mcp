import {
  setup,
  factBuilders,
  assertAttempt,
} from '../test/observation-test-helpers.js';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { expect, test } from 'vitest';

const { decision, started, operationEnd } = factBuilders('cost');

test('an initial zero-cost project bypasses issuance', async () => {
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
  expect(h.createProject).toHaveBeenCalledTimes(1);
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
