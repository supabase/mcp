import {
  CLIENT_CAPABILITIES_META_KEY,
  inputResponse,
  PROTOCOL_VERSION_META_KEY,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { ObservationFact } from '@supabase/mcp-utils';
import { z } from 'zod/v4';
import type { BranchCost, Cost } from '../pricing.js';
import { AWS_REGION_CODES } from '../regions.js';

/**
 * Signed `requestState` payload for the `create_project` cost-confirmation
 * elicitation, bound to the project arguments and the cost quoted to the
 * user.
 */
export type ProjectCostState = {
  tool: 'create_project';
  name: string;
  region: (typeof AWS_REGION_CODES)[number];
  organization_id: string;
  cost: Cost;
};

const costSchema: z.ZodType<Cost> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project'),
    recurrence: z.literal('monthly'),
    amount: z.number(),
  }),
  z.object({
    type: z.literal('branch'),
    recurrence: z.literal('hourly'),
    amount: z.number(),
  }),
]);

export const projectCostStateSchema = z.object({
  tool: z.literal('create_project'),
  name: z.string(),
  region: z.enum(AWS_REGION_CODES),
  organization_id: z.string(),
  cost: costSchema,
}) satisfies z.ZodType<ProjectCostState>;

/**
 * Signed `requestState` payload for the `create_branch` cost-confirmation
 * elicitation, bound to the branch arguments and the cost quoted to the
 * user.
 */
export type BranchCostState = {
  tool: 'create_branch';
  project_id: string;
  name: string;
  cost: BranchCost;
};

export const branchCostStateSchema = z.object({
  tool: z.literal('create_branch'),
  project_id: z.string(),
  name: z.string(),
  cost: z.object({
    type: z.literal('branch'),
    recurrence: z.literal('hourly'),
    amount: z.number(),
  }),
}) satisfies z.ZodType<BranchCostState>;

export type ExecuteSqlState = {
  tool: 'execute_sql';
  project_id: string;
  queryHash: string;
};

export type ApplyMigrationState = {
  tool: 'apply_migration';
  project_id: string;
  name: string;
  queryHash: string;
};

export type DestructiveSqlState = ExecuteSqlState | ApplyMigrationState;
export type CostConfirmationState = ProjectCostState | BranchCostState;

/**
 * Signed `requestState` payload for any confirmation elicitation this server
 * issues, discriminated by `tool`.
 */
export type ConfirmationState = CostConfirmationState | DestructiveSqlState;

/**
 * Signed state for URL-mode secret collection, bound to the project and name.
 * The original `issued_at` timestamp is preserved across reissues.
 */
export type SecretCollectionState = {
  tool: 'create_edge_function_secret';
  project_id: string;
  name: string;
  /** Epoch ms, floored to the second; the platform reports updated_at at second precision. */
  issued_at: number;
};

/** Shared codec payload; each flow validates its own narrower state. */
export type ElicitationState = ConfirmationState | SecretCollectionState;

export const executeSqlStateSchema = z.object({
  tool: z.literal('execute_sql'),
  project_id: z.string(),
  queryHash: z.string(),
}) satisfies z.ZodType<ExecuteSqlState>;

export const applyMigrationStateSchema = z.object({
  tool: z.literal('apply_migration'),
  project_id: z.string(),
  name: z.string(),
  queryHash: z.string(),
}) satisfies z.ZodType<ApplyMigrationState>;

export type CheckConfirmationStateResult =
  | { kind: 'proceed' }
  | { kind: 'reprompt'; result: InputRequiredResult }
  | { kind: 'terminal'; result: CallToolResult };

type ConfirmationStateOptions<S extends ConfirmationState> = {
  ctx: ServerContext;
  tool: S['tool'];
  schema: z.ZodType<S>;
  requestKey: string;
  argsMatch: (state: S) => boolean;
  payloadMatch?: (state: S) => boolean;
  declinedText: string;
  cancelledText: string;
};

type CostConfirmationRecord = (
  fact: Extract<
    ObservationFact,
    { kind: 'resume_validation' | 'input_response' }
  >
) => void;

type RepromptReason = 'initial' | 'missing_response' | 'changed_quote';

type ConfirmationDecision<S extends ConfirmationState> =
  | { kind: 'proceed'; state: S }
  | { kind: 'reprompt'; reason: RepromptReason }
  | { kind: 'terminal'; result: CallToolResult };

export async function checkConfirmationState<S extends ConfirmationState>(
  options: ConfirmationStateOptions<S> & {
    askForConfirmation: (
      reason: RepromptReason
    ) => Promise<InputRequiredResult>;
    /** Internal cost-only recorder; SQL callers do not provide one. */
    recordCost?: CostConfirmationRecord;
  }
): Promise<
  CheckConfirmationStateResult &
    (
      | { kind: 'proceed'; state: S }
      | { kind: 'reprompt' }
      | { kind: 'terminal' }
    )
> {
  const decision = inspectConfirmationState(options, options.recordCost);
  return decision.kind === 'reprompt'
    ? {
        kind: 'reprompt',
        result: await options.askForConfirmation(decision.reason),
      }
    : decision;
}

/** Inspect SDK-verified state without issuing a new confirmation. */
export function inspectConfirmationState<S extends ConfirmationState>(
  options: ConfirmationStateOptions<S>,
  recordCost?: CostConfirmationRecord
): ConfirmationDecision<S> {
  const {
    ctx,
    tool,
    schema,
    requestKey,
    argsMatch,
    payloadMatch,
    declinedText,
    cancelledText,
  } = options;
  const raw = ctx.mcpReq.requestState<unknown>();
  if (raw === undefined) {
    return { kind: 'reprompt', reason: 'initial' };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data.tool !== tool) {
    // Schema rejection remains authoritative. A malformed same-tool payload
    // has no truthful classification in the finite cost observation contract.
    if (
      recordCost &&
      raw !== null &&
      typeof raw === 'object' &&
      'tool' in raw &&
      typeof raw.tool === 'string' &&
      raw.tool !== tool
    ) {
      recordCost?.({
        kind: 'resume_validation',
        feature: 'cost',
        result: 'tool_mismatch',
      });
    }
    return {
      kind: 'terminal',
      result: {
        content: [
          {
            type: 'text',
            text: `Request state was not issued for ${tool}.`,
          },
        ],
        structuredContent: { status: 'error' },
        isError: true,
      },
    };
  }

  const state = parsed.data;
  if (!argsMatch(state)) {
    recordCost?.({
      kind: 'resume_validation',
      feature: 'cost',
      result: 'arguments_mismatch',
    });
    return {
      kind: 'terminal',
      result: {
        content: [
          {
            type: 'text',
            text: 'Request state arguments do not match the current arguments.',
          },
        ],
        structuredContent: { status: 'error' },
        isError: true,
      },
    };
  }

  const response = inputResponse(ctx.mcpReq.inputResponses, requestKey);
  if (response.kind !== 'elicit') {
    recordCost?.({
      kind: 'resume_validation',
      feature: 'cost',
      result: 'missing_response',
    });
    return { kind: 'reprompt', reason: 'missing_response' };
  }

  recordCost?.({
    kind: 'input_response',
    feature: 'cost',
    action:
      response.action === 'accept' || response.action === 'decline'
        ? response.action
        : 'cancel',
  });

  if (response.action === 'decline') {
    return {
      kind: 'terminal',
      result: {
        content: [{ type: 'text', text: declinedText }],
        structuredContent: { status: 'declined' },
      },
    };
  }

  if (response.action !== 'accept') {
    return {
      kind: 'terminal',
      result: {
        content: [{ type: 'text', text: cancelledText }],
        structuredContent: { status: 'cancelled' },
      },
    };
  }

  if (payloadMatch && !payloadMatch(state)) {
    recordCost?.({
      kind: 'resume_validation',
      feature: 'cost',
      result: 'changed_quote',
    });
    return { kind: 'reprompt', reason: 'changed_quote' };
  }

  recordCost?.({
    kind: 'resume_validation',
    feature: 'cost',
    result: 'valid',
  });
  return { kind: 'proceed', state };
}

/**
 * An action-only elicitation: no properties, so the client renders the
 * message with just its accept/decline/cancel controls and consent lives
 * in `action`.
 */
export const actionOnlyElicitationSchema = {
  type: 'object' as const,
  properties: {},
};

/**
 * Whether the current request declares per-request form-elicitation
 * capability (protocol revision 2026-07-28): an `elicitation` declaration
 * with an empty mode map or an explicit `form` mode.
 */
export function isFormCapable(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  if (typeof envelope?.[PROTOCOL_VERSION_META_KEY] !== 'string') {
    return false;
  }

  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY] as
    | { elicitation?: Record<string, unknown> }
    | undefined;
  const elicitation = capabilities?.elicitation;
  if (elicitation === undefined) {
    return false;
  }

  const modes = Object.keys(elicitation);
  return modes.length === 0 || modes.includes('form');
}

/**
 * Whether the current request declares per-request url-elicitation
 * capability (protocol revision 2026-07-28): an `elicitation` declaration
 * with a `url` mode.
 */
export function isUrlCapable(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  if (typeof envelope?.[PROTOCOL_VERSION_META_KEY] !== 'string') {
    return false;
  }

  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY] as
    | { elicitation?: Record<string, unknown> }
    | undefined;
  const elicitation = capabilities?.elicitation;
  if (elicitation === undefined) {
    return false;
  }

  return 'url' in elicitation;
}
