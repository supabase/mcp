import {
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { ObservationFact } from '../observation.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  checkConfirmationState,
  observeOperation,
  projectCostStateSchema,
  type CostConfirmationState,
} from './confirmation.js';

afterEach(() => vi.restoreAllMocks());

describe('observeOperation', () => {
  const feature = 'cost' as const;
  test('records started before execution and returned with exact duration', async () => {
    let now = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const facts: ObservationFact[] = [];
    const result = { id: 'created' };
    const returned = await observeOperation(
      feature,
      (fact) => {
        facts.push(fact);
        now += 2;
      },
      async () => {
        expect(facts).toEqual([
          { kind: 'operation', feature, disposition: 'started' },
        ]);
        now = 37;
        return result;
      }
    );
    expect(returned).toBe(result);
    expect(facts).toEqual([
      { kind: 'operation', feature, disposition: 'started' },
      {
        kind: 'operation',
        feature,
        disposition: 'returned',
        durationMs: 25,
      },
    ]);
  });

  test('records threw with exact duration and rethrows the original error', async () => {
    const failure = new Error('operation failed');
    const facts: ObservationFact[] = [];
    vi.spyOn(performance, 'now').mockReturnValueOnce(5).mockReturnValueOnce(14);
    await expect(
      observeOperation(
        feature,
        (fact) => facts.push(fact),
        async () => {
          expect(facts).toEqual([
            { kind: 'operation', feature, disposition: 'started' },
          ]);
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    expect(facts).toEqual([
      { kind: 'operation', feature, disposition: 'started' },
      {
        kind: 'operation',
        feature,
        disposition: 'threw',
        durationMs: 9,
      },
    ]);
  });
});

const schema = projectCostStateSchema;
const state = {
  tool: 'create_project',
  name: 'project',
  region: 'us-east-1',
  organization_id: 'organization',
  cost: { type: 'project', recurrence: 'monthly', amount: 10 },
} as const;

describe('create_project confirmation observations', () => {
  function options(
    facts: ObservationFact[],
    askForConfirmation: () => Promise<InputRequiredResult>
  ) {
    // Only the request-state/response slice used by the checker is needed here.
    const ctx = {
      mcpReq: {
        requestState: () => undefined,
      },
    } as unknown as ServerContext;
    return {
      ctx,
      tool: state.tool,
      schema,
      requestKey: 'confirm_cost',
      argsMatch: () => true,
      payloadMatch: () => true,
      declinedText: 'Declined.',
      cancelledText: 'Cancelled.',
      observation: {
        record: (fact: ObservationFact) => {
          facts.push(fact);
        },
        setOutcome: vi.fn(),
      },
      askForConfirmation,
    };
  }

  test('failed issuance preserves prior facts without recording input_required', async () => {
    const facts: ObservationFact[] = [];
    const failure = new Error('mint or response construction failed');
    await expect(
      checkConfirmationState<CostConfirmationState>(
        options(facts, async () => {
          throw failure;
        })
      )
    ).rejects.toBe(failure);
    expect(facts).toEqual([]);
  });

  test('malformed same-tool state returns generic error without a false validation or consumed response', async () => {
    const facts: ObservationFact[] = [];
    const { cost: _cost, ...malformed } = state;
    const ctx = {
      mcpReq: {
        requestState: () => malformed,
        inputResponses: {
          confirm_cost: { action: 'accept', content: {} },
        },
      },
    } as unknown as ServerContext;
    const askForConfirmation = vi.fn(async (): Promise<InputRequiredResult> => {
      throw new Error('must not issue a new round');
    });
    const result = await checkConfirmationState<CostConfirmationState>({
      ...options(facts, askForConfirmation),
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
  });
});
