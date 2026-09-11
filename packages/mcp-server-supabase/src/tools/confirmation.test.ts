import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';

import {
  checkConfirmationState,
  executeSqlStateSchema,
  isFormCapable,
} from './confirmation.js';

// Minimal ServerContext stub: only the envelope slice isFormCapable reads.
function makeCtx(envelope: Record<string, unknown>): ServerContext {
  return {
    mcpReq: { envelope },
  } as unknown as ServerContext;
}

// A valid envelope that satisfies both meta-key checks.
function validBase(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
  };
}

describe('isFormCapable', () => {
  test.each([
    {
      label: 'no elicitation key in capabilities',
      envelope: {
        ...validBase(),
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
      expected: false,
    },
    {
      label: 'elicitation is an empty object (any mode accepted)',
      envelope: {
        ...validBase(),
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} },
      },
      expected: true,
    },
    {
      label: 'elicitation has url mode only',
      envelope: {
        ...validBase(),
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
      },
      expected: false,
    },
    {
      label: 'elicitation has form mode',
      envelope: {
        ...validBase(),
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
      },
      expected: true,
    },
    {
      label: 'form capability present but protocol version meta key absent',
      envelope: {
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
        // PROTOCOL_VERSION_META_KEY intentionally omitted
      },
      expected: false,
    },
  ])('$label -> $expected', ({ envelope, expected }) => {
    expect(isFormCapable(makeCtx(envelope))).toBe(expected);
  });
});

describe('checkConfirmationState', () => {
  test('returns a terminal error when decoded state fails the tool schema', async () => {
    const ctx = {
      mcpReq: {
        requestState: () => ({
          tool: 'execute_sql',
          project_id: 'project-1',
        }),
      },
    } as unknown as ServerContext;

    const result = await checkConfirmationState({
      ctx,
      tool: 'execute_sql',
      schema: executeSqlStateSchema,
      requestKey: 'confirm_destructive',
      askForConfirmation: async () => {
        throw new Error('must not ask for confirmation');
      },
      argsMatch: () => true,
      declinedText: 'SQL execution was declined.',
      cancelledText: 'SQL execution was cancelled.',
    });

    expect(result).toEqual({
      kind: 'terminal',
      result: {
        content: [
          {
            type: 'text',
            text: 'Request state was not issued for execute_sql.',
          },
        ],
        structuredContent: { status: 'error' },
        isError: true,
      },
    });
  });
});
