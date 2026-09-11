import {
  mintControl,
  form,
  tools,
  setup,
  issued,
  decision,
  required,
  validation,
  response,
  started,
  operationEnd,
  assertAttempt,
  changeQuote,
} from './observation-test-helpers.js';
import {
  isInputRequiredResult,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { describe, expect, test, vi } from 'vitest';
import * as pricing from './pricing.js';
import { hashObject } from './util.js';

describe.each(tools)('%s observation', (name) => {
  test('settles initial issuance immediately, without an operation or a waiting scope', async () => {
    const h = await setup();
    issued(await h.call(name));
    assertAttempt(
      h.attempts[0],
      name,
      [decision('inline', 'eligible'), required('initial')],
      'input_required'
    );
    expect(h.operation(name)).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]!.ends).toHaveLength(1);
  });

  test.each(['accept', 'decline', 'cancel'] as const)(
    'records consumed %s and the actual operation only',
    async (action) => {
      const h = await setup({ injected: name === 'create_branch' });
      const first = issued(await h.call(name));
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
            ? [validation('valid'), started, operationEnd('returned')]
            : []),
        ],
        accepted ? 'completed' : action === 'decline' ? 'declined' : 'cancelled'
      );
      expect(h.operation(name)).toHaveBeenCalledTimes(accepted ? 1 : 0);
      if (accepted) expect((result as CallToolResult).isError).not.toBe(true);
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
    changeQuote(name);
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

  test.each(['initial', 'missing_response', 'changed_quote'] as const)(
    'failed %s mint does not count an issued round',
    async (reason) => {
      const h = await setup();
      const first =
        reason === 'initial' ? undefined : issued(await h.call(name));
      if (reason === 'changed_quote') changeQuote(name);
      mintControl.fail = true;
      const result = await h.call(
        name,
        first
          ? {
              requestState: first.requestState,
              ...(reason === 'changed_quote'
                ? {
                    inputResponses: {
                      confirm_cost: { action: 'accept' as const, content: {} },
                    },
                  }
                : {}),
            }
          : {}
      );
      expect((result as CallToolResult).isError).toBe(true);
      const prior =
        reason === 'initial'
          ? []
          : reason === 'missing_response'
            ? [validation('missing_response')]
            : [response('accept'), validation('changed_quote')];
      assertAttempt(
        h.attempts.at(-1),
        name,
        [decision('inline', 'eligible'), ...prior],
        'tool_error'
      );
      expect(h.operation(name)).not.toHaveBeenCalled();
    }
  );

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
      configured: false,
      capabilities: form,
      reason: 'not_configured' as const,
    },
    {
      legacy: true,
      configured: true,
      capabilities: form,
      reason: 'capability_missing' as const,
    },
    {
      legacy: false,
      configured: true,
      capabilities: {},
      reason: 'capability_missing' as const,
    },
    {
      legacy: false,
      configured: true,
      capabilities: { elicitation: { url: {} } },
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

  test.each(['signature', 'expiry'] as const)(
    'SDK %s rejection creates no additional scope',
    async (kind) => {
      const h = await setup();
      const first = issued(await h.call(name));
      let requestState = first.requestState as string;
      if (kind === 'signature') {
        const segments = requestState.split('.');
        const signature = segments.pop()!;
        segments.push((signature[0] === 'a' ? 'b' : 'a') + signature.slice(1));
        requestState = segments.join('.');
      } else {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
      }
      await expect(
        h.call(name, {
          requestState,
          inputResponses: { confirm_cost: { action: 'accept', content: {} } },
        })
      ).rejects.toMatchObject({ code: -32602 });
      expect(h.attempts).toHaveLength(1);
      expect(h.operation(name)).not.toHaveBeenCalled();
    }
  );
});

test.each(tools)(
  '%s decline/cancel takes precedence over a changed quote',
  async (name) => {
    const h = await setup();
    const first = issued(await h.call(name));
    changeQuote(name);
    for (const action of ['decline', 'cancel'] as const) {
      const result = await h.call(name, {
        requestState: first.requestState,
        inputResponses: { confirm_cost: { action } },
      });
      expect((result as CallToolResult).structuredContent).toEqual({
        status: action === 'decline' ? 'declined' : 'cancelled',
      });
      assertAttempt(
        h.attempts.at(-1),
        name,
        [decision('inline', 'eligible'), response(action)],
        action === 'decline' ? 'declined' : 'cancelled'
      );
    }
    expect(h.operation(name)).not.toHaveBeenCalled();
  }
);
