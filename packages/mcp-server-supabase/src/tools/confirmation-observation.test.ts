import {
  inputRequired,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { ObservationFact } from '@supabase/mcp-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  actionOnlyElicitationSchema,
  branchCostStateSchema,
  checkConfirmationState,
  observeCostOperation,
  projectCostStateSchema,
  type CostConfirmationState,
} from './confirmation.js';

afterEach(() => vi.restoreAllMocks());

describe('observeCostOperation', () => {
  test('records started before execution and returned with exact duration', async () => {
    let now = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const facts: ObservationFact[] = [];
    const result = { id: 'created' };
    const returned = await observeCostOperation(
      (fact) => {
        facts.push(fact);
        now += 2;
      },
      async () => {
        expect(facts).toEqual([
          { kind: 'operation', feature: 'cost', disposition: 'started' },
        ]);
        now = 37;
        return result;
      }
    );
    expect(returned).toBe(result);
    expect(facts).toEqual([
      { kind: 'operation', feature: 'cost', disposition: 'started' },
      {
        kind: 'operation',
        feature: 'cost',
        disposition: 'returned',
        durationMs: 27,
      },
    ]);
  });

  test('records threw with exact duration and rethrows the original error', async () => {
    const failure = new Error('operation failed');
    const facts: ObservationFact[] = [];
    vi.spyOn(performance, 'now').mockReturnValueOnce(5).mockReturnValueOnce(14);
    await expect(
      observeCostOperation(
        (fact) => facts.push(fact),
        async () => {
          expect(facts).toEqual([
            { kind: 'operation', feature: 'cost', disposition: 'started' },
          ]);
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    expect(facts).toEqual([
      { kind: 'operation', feature: 'cost', disposition: 'started' },
      {
        kind: 'operation',
        feature: 'cost',
        disposition: 'threw',
        durationMs: 9,
      },
    ]);
  });

  test('without a recorder returns the original operation promise without reading the clock', async () => {
    const clock = vi.spyOn(performance, 'now');
    const result = { id: 'created' };
    const promise = Promise.resolve(result);
    const run = vi.fn(() => promise);
    const returned = observeCostOperation(undefined, run);
    expect(returned).toBe(promise);
    expect(await returned).toBe(result);
    expect(run).toHaveBeenCalledOnce();
    expect(clock).not.toHaveBeenCalled();
  });
});

const producers = [
  {
    tool: 'create_project',
    schema: projectCostStateSchema,
    state: {
      tool: 'create_project',
      name: 'project',
      region: 'us-east-1',
      organization_id: 'organization',
      cost: { type: 'project', recurrence: 'monthly', amount: 10 },
    },
  },
  {
    tool: 'create_branch',
    schema: branchCostStateSchema,
    state: {
      tool: 'create_branch',
      project_id: 'project',
      name: 'branch',
      cost: { type: 'branch', recurrence: 'hourly', amount: 0.01344 },
    },
  },
] as const;

const rounds: {
  reason: 'initial' | 'missing_response' | 'changed_quote';
  prior: ObservationFact[];
}[] = [
  { reason: 'initial', prior: [] },
  {
    reason: 'missing_response',
    prior: [
      {
        kind: 'resume_validation',
        feature: 'cost',
        result: 'missing_response',
      },
    ],
  },
  {
    reason: 'changed_quote',
    prior: [
      { kind: 'input_response', feature: 'cost', action: 'accept' },
      { kind: 'resume_validation', feature: 'cost', result: 'changed_quote' },
    ],
  },
];

describe.each(producers)(
  '$tool confirmation observations',
  ({ tool, schema, state }) => {
    function options(
      reason: (typeof rounds)[number]['reason'],
      facts: ObservationFact[],
      askForConfirmation: () => Promise<InputRequiredResult>
    ) {
      // Only the request-state/response slice used by the checker is needed here.
      const ctx = {
        mcpReq: {
          requestState: () => (reason === 'initial' ? undefined : state),
          inputResponses:
            reason === 'changed_quote'
              ? { confirm_cost: { action: 'accept', content: {} } }
              : undefined,
        },
      } as unknown as ServerContext;
      return {
        ctx,
        tool,
        schema,
        requestKey: 'confirm_cost',
        argsMatch: () => true,
        payloadMatch: () => reason !== 'changed_quote',
        declinedText: 'Declined.',
        cancelledText: 'Cancelled.',
        recordCost: (fact: ObservationFact) => {
          facts.push(fact);
        },
        askForConfirmation,
      };
    }

    test.each(rounds)(
      'records $reason issuance only after the response resolves',
      async ({ reason, prior }) => {
        const facts: ObservationFact[] = [];
        const issued = inputRequired({
          inputRequests: {
            confirm_cost: inputRequired.elicit({
              mode: 'form',
              message: 'Confirm cost.',
              requestedSchema: actionOnlyElicitationSchema,
            }),
          },
          requestState: 'new-signed-state',
        });
        const result = await checkConfirmationState<CostConfirmationState>(
          options(reason, facts, async () => {
            await Promise.resolve();
            expect(facts).toEqual(prior);
            return issued;
          })
        );
        expect(result).toEqual({ kind: 'reprompt', result: issued });
        expect(facts).toEqual([
          ...prior,
          { kind: 'input_required', feature: 'cost', mode: 'form', reason },
        ]);
      }
    );

    test.each(rounds)(
      'rejecting $reason ask preserves prior facts without recording input_required',
      async ({ reason, prior }) => {
        const facts: ObservationFact[] = [];
        const failure = new Error('mint or response construction failed');
        await expect(
          checkConfirmationState<CostConfirmationState>(
            options(reason, facts, async () => {
              throw failure;
            })
          )
        ).rejects.toBe(failure);
        expect(facts).toEqual(prior);
      }
    );

    test('malformed same-tool state returns generic error without a false validation or consumed response', async () => {
      const facts: ObservationFact[] = [];
      const { cost: _cost, ...malformed } = state;
      const inputResponses = vi.fn(() => ({
        confirm_cost: { action: 'accept', content: {} },
      }));
      // The schema must reject before even reading the supplied accept response.
      const ctx = {
        mcpReq: {
          requestState: () => malformed,
          get inputResponses() {
            return inputResponses();
          },
        },
      } as unknown as ServerContext;
      const askForConfirmation = vi.fn(
        async (): Promise<InputRequiredResult> => {
          throw new Error('must not issue a new round');
        }
      );
      const result = await checkConfirmationState<CostConfirmationState>({
        ...options('initial', facts, askForConfirmation),
        ctx,
      });
      expect(result).toMatchObject({
        kind: 'terminal',
        result: {
          structuredContent: { status: 'error' },
          isError: true,
        },
      });
      expect(facts).toEqual([]);
      expect(inputResponses).not.toHaveBeenCalled();
      expect(askForConfirmation).not.toHaveBeenCalled();
    });
  }
);
