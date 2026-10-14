import {
  tools,
  setup,
  issued,
  factBuilders,
  assertAttempt,
} from '../test/observation-test-helpers.js';
import {
  isInputRequiredResult,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { describe, expect, test, vi } from 'vitest';
import * as pricing from './pricing.js';
import { hashObject } from './util.js';
import { callModernTool } from '../test/server-harness.js';

const { decision, required, validation, response, started, operationEnd } =
  factBuilders('cost');

describe.each(tools)('%s observation', (name) => {
  test('settles initial issuance immediately without an operation', async () => {
    const h = await setup();
    issued(await h.call(name));
    assertAttempt(
      h.attempts[0],
      name,
      [decision('inline', 'eligible'), required('initial')],
      'input_required'
    );
    expect(h.operation(name)).not.toHaveBeenCalled();
  });

  test.each([
    { action: 'accept', fails: false, outcome: 'completed' },
    { action: 'decline', fails: false, outcome: 'declined' },
    { action: 'cancel', fails: false, outcome: 'cancelled' },
    { action: 'accept', fails: true, outcome: 'tool_error' },
  ] as const)(
    'records consumed $action (platform fails=$fails), including injected create_branch observation',
    async ({ action, fails, outcome }) => {
      const h = await setup({ injected: name === 'create_branch' });
      const first = issued(await h.call(name));
      if (fails)
        h.operation(name).mockRejectedValueOnce(
          new Error('PRIVATE_PLATFORM_ERROR')
        );
      const result = await h.call(name, {
        requestState: first.requestState,
        inputResponses: {
          confirm_cost:
            action === 'accept' ? { action, content: {} } : { action },
        },
      });
      expect(isInputRequiredResult(result)).toBe(false);
      const accepted = action === 'accept';
      assertAttempt(
        h.attempts[1],
        name,
        [
          decision('inline', 'eligible'),
          response(action),
          ...(accepted
            ? [
                validation('valid'),
                started,
                operationEnd(fails ? 'threw' : 'returned'),
              ]
            : []),
        ],
        outcome
      );
      expect(h.operation(name)).toHaveBeenCalledTimes(accepted ? 1 : 0);
      if (accepted)
        expect((result as CallToolResult).isError === true).toBe(fails);
      if (fails)
        expect(JSON.stringify(result)).toContain('PRIVATE_PLATFORM_ERROR');
    }
  );

  test.each([undefined, { confirm_cost: { roots: [] } }])(
    'reissues missing/non-elicit response without a consumed action',
    async (inputResponses) => {
      const h = await setup();
      const first = issued(await h.call(name));
      issued(
        await h.call(name, { requestState: first.requestState, inputResponses })
      );
      assertAttempt(
        h.attempts[1],
        name,
        [
          decision('inline', 'eligible'),
          validation('missing_response'),
          required('missing_response'),
        ],
        'input_required'
      );
      expect(h.operation(name)).not.toHaveBeenCalled();
    }
  );

  test('accepting a changed quote issues another round rather than executing', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    if (name === 'create_project')
      vi.spyOn(pricing, 'getNextProjectCost').mockResolvedValue({
        type: 'project',
        recurrence: 'monthly',
        amount: 20,
      });
    else
      vi.spyOn(pricing, 'getBranchCost').mockReturnValue({
        type: 'branch',
        recurrence: 'hourly',
        amount: 0.02,
      });
    issued(
      await h.call(name, {
        requestState: first.requestState,
        inputResponses: { confirm_cost: { action: 'accept', content: {} } },
      })
    );
    assertAttempt(
      h.attempts[1],
      name,
      [
        decision('inline', 'eligible'),
        response('accept'),
        validation('changed_quote'),
        required('changed_quote'),
      ],
      'input_required'
    );
    expect(h.operation(name)).not.toHaveBeenCalled();
  });

  test.each(['tool_mismatch', 'arguments_mismatch'] as const)(
    'rejects %s without consuming accept',
    async (mismatch) => {
      const h = await setup();
      const other =
        name === 'create_project' ? 'create_branch' : 'create_project';
      const first = issued(
        await h.call(mismatch === 'tool_mismatch' ? other : name)
      );
      const result = await h.call(name, {
        requestState: first.requestState,
        arguments: {
          ...h.args(name),
          ...(mismatch === 'arguments_mismatch'
            ? { name: 'CHANGED_PRIVATE_NAME' }
            : {}),
        },
        inputResponses: { confirm_cost: { action: 'accept', content: {} } },
      });
      expect((result as CallToolResult).isError).toBe(true);
      assertAttempt(
        h.attempts[1],
        name,
        [decision('inline', 'eligible'), validation(mismatch)],
        'tool_error'
      );
      expect(h.operation(name)).not.toHaveBeenCalled();
    }
  );

  test.each([
    {
      legacy: true,
      configured: false,
      capabilities: {},
      reason: 'not_configured' as const,
    },
    {
      legacy: false,
      configured: true,
      capabilities: {},
      reason: 'capability_missing' as const,
    },
  ])(
    'preserves legacy protection: $legacy/$configured/$reason/$capabilities',
    async (options) => {
      const h = await setup(options);
      const cost =
        name === 'create_project'
          ? { type: 'project', recurrence: 'monthly', amount: 10 }
          : pricing.getBranchCost();
      const result = await h.call(name, {
        arguments: { ...h.args(name), confirm_cost_id: await hashObject(cost) },
      });
      expect((result as CallToolResult).isError).not.toBe(true);
      assertAttempt(
        h.attempts[0],
        name,
        [decision('legacy', options.reason), started, operationEnd('returned')],
        'completed'
      );
      expect(h.operation(name)).toHaveBeenCalledTimes(1);
      const failure = await h.call(name, {
        arguments: { ...h.args(name), confirm_cost_id: 'PRIVATE_INVALID_HASH' },
      });
      expect((failure as CallToolResult).isError).toBe(true);
      assertAttempt(
        h.attempts[1],
        name,
        [decision('legacy', options.reason)],
        'tool_error'
      );
      expect(h.operation(name)).toHaveBeenCalledTimes(1);
    }
  );

  test('read-only rejection is the decisive branch', async () => {
    const h = await setup({ readOnly: true });
    expect(((await h.call(name)) as CallToolResult).isError).toBe(true);
    assertAttempt(
      h.attempts[0],
      name,
      [decision('blocked', 'read_only')],
      'tool_error'
    );
    expect(h.operation(name)).not.toHaveBeenCalled();
  });
});

test.each([
  {
    name: 'list_projects',
    args: {},
    bucket: 'other',
  },
  {
    name: 'execute_sql',
    args: { project_id: 'PRIVATE_PROJECT', query: 'SELECT 1;' },
    bucket: 'execute_sql',
  },
  {
    name: 'apply_migration',
    args: {
      project_id: 'PRIVATE_PROJECT',
      name: 'PRIVATE_MIGRATION',
      query: 'SELECT 1;',
    },
    bucket: 'apply_migration',
  },
] as const)(
  '$name records the $bucket bucket without feature facts',
  async ({ name, args, bucket }) => {
    const h = await setup({ configured: false });
    await callModernTool(h.client, { name, arguments: args });
    expect(h.attempts).toEqual([
      {
        context: { method: 'tools/call', tool: bucket },
        facts: [],
        ends: [{ result: 'completed', durationMs: expect.any(Number) }],
      },
    ]);
    const duration = h.attempts[0]!.ends[0]!.durationMs;
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(0);
  }
);
