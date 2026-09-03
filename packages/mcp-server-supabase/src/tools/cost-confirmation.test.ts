import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';

import { isFormCapable, isUrlCapable } from './cost-confirmation.js';

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

describe('isUrlCapable', () => {
  test.each([
    {
      label: 'url mode only',
      envelope: {
        ...validBase(),
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
      },
      expected: true,
    },
    {
      label: 'form mode only',
      envelope: {
        ...validBase(),
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
      },
      expected: false,
    },
    {
      label: 'elicitation is an empty object',
      envelope: {
        ...validBase(),
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} },
      },
      expected: false,
    },
    {
      label: 'no elicitation key in capabilities',
      envelope: {
        ...validBase(),
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
      expected: false,
    },
    {
      label: 'protocol version meta key absent',
      envelope: {
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
        // PROTOCOL_VERSION_META_KEY intentionally omitted
      },
      expected: false,
    },
  ])('$label -> $expected', ({ envelope, expected }) => {
    expect(isUrlCapable(makeCtx(envelope))).toBe(expected);
  });
});
