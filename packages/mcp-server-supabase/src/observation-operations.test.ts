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
import type { Branch, Project } from './platform/types.js';
import * as pricing from './pricing.js';
import { hashObject } from './util.js';

describe.each(tools)('%s observation', (name) => {
  test('platform rejection wins over an accepted response', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    h.operation(name).mockRejectedValueOnce(
      new Error('PRIVATE_PLATFORM_ERROR')
    );
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

// Node 20 is supported; Promise.withResolvers is not available there.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('reverse completion keeps operation timings and terminal sequences request-local', async () => {
  const h = await setup();
  const projectFirst = issued(await h.call('create_project'));
  const branchFirst = issued(await h.call('create_branch'));
  let now = 10;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const projectGate = deferred<Project>();
  const branchGate = deferred<Branch>();
  const projectEntered = deferred<void>();
  const branchEntered = deferred<void>();
  h.createProject.mockImplementationOnce(() => {
    projectEntered.resolve();
    return projectGate.promise;
  });
  h.createBranch.mockImplementationOnce(() => {
    branchEntered.resolve();
    return branchGate.promise;
  });
  const projectCall = h.call('create_project', {
    requestState: projectFirst.requestState,
    inputResponses: { confirm_cost: { action: 'accept', content: {} } },
  });
  await projectEntered.promise;
  now = 20;
  const branchCall = h.call('create_branch', {
    requestState: branchFirst.requestState,
    inputResponses: { confirm_cost: { action: 'accept', content: {} } },
  });
  await branchEntered.promise;
  now = 30;
  branchGate.resolve(h.branch);
  await branchCall;
  expect(h.attempts[2]!.ends).toEqual([]);
  expect(h.attempts[3]!.ends).toEqual([
    { result: 'completed', durationMs: 10 },
  ]);
  now = 50;
  projectGate.resolve(h.project);
  await projectCall;
  expect(h.attempts[2]!.ends).toEqual([
    { result: 'completed', durationMs: 40 },
  ]);
  expect(h.attempts[2]!.facts.at(-1)).toEqual({
    kind: 'operation',
    feature: 'cost',
    disposition: 'returned',
    durationMs: 40,
  });
  expect(h.attempts[3]!.facts.at(-1)).toEqual({
    kind: 'operation',
    feature: 'cost',
    disposition: 'returned',
    durationMs: 10,
  });
  expect(h.createProject).toHaveBeenCalledTimes(1);
  expect(h.createBranch).toHaveBeenCalledTimes(1);
});

test.each(tools)(
  '%s legacy platform rejection has operation facts, not a modern validation',
  async (name) => {
    const h = await setup({ legacy: true, capabilities: {} });
    const cost =
      name === 'create_project'
        ? { type: 'project', recurrence: 'monthly', amount: 10 }
        : pricing.getBranchCost();
    h.operation(name).mockRejectedValueOnce(new Error('PRIVATE_LEGACY_ERROR'));
    const result = await h.call(name, {
      arguments: { ...h.args(name), confirm_cost_id: await hashObject(cost) },
    });
    expect((result as CallToolResult).isError).toBe(true);
    assertAttempt(
      h.attempts[0],
      name,
      [
        decision('legacy', 'capability_missing'),
        started,
        operationEnd('threw'),
      ],
      'tool_error'
    );
    expect(h.operation(name)).toHaveBeenCalledTimes(1);
  }
);

test('zero-cost project failure still reports the actual protected call', async () => {
  const h = await setup();
  h.platform.account.listProjects.mockResolvedValue([]);
  h.createProject.mockRejectedValueOnce(new Error('PRIVATE_ZERO_COST_ERROR'));
  expect(((await h.call('create_project')) as CallToolResult).isError).toBe(
    true
  );
  assertAttempt(
    h.attempts[0],
    'create_project',
    [decision('bypass', 'zero_cost'), started, operationEnd('threw')],
    'tool_error'
  );
  expect(h.createProject).toHaveBeenCalledTimes(1);
});
