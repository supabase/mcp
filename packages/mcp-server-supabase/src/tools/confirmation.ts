import {
  CLIENT_CAPABILITIES_META_KEY,
  inputResponse,
  PROTOCOL_VERSION_META_KEY,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
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

export const confirmationStateSchema = z.discriminatedUnion('tool', [
  projectCostStateSchema,
  branchCostStateSchema,
  executeSqlStateSchema,
  applyMigrationStateSchema,
]);

export type CheckConfirmationStateResult =
  | { kind: 'proceed' }
  | { kind: 'reprompt'; result: InputRequiredResult }
  | { kind: 'terminal'; result: CallToolResult };

export async function checkConfirmationState<
  S extends ConfirmationState,
>(options: {
  ctx: ServerContext;
  tool: S['tool'];
  schema: z.ZodType<S>;
  requestKey: string;
  askForConfirmation: () => Promise<InputRequiredResult>;
  argsMatch: (state: S) => boolean;
  payloadMatch?: (state: S) => boolean;
  declinedText: string;
  cancelledText: string;
}): Promise<
  CheckConfirmationStateResult &
    (
      | { kind: 'proceed'; state: S }
      | { kind: 'reprompt' }
      | { kind: 'terminal' }
    )
> {
  const {
    ctx,
    tool,
    schema,
    requestKey,
    askForConfirmation,
    argsMatch,
    payloadMatch,
    declinedText,
    cancelledText,
  } = options;
  const raw = ctx.mcpReq.requestState<unknown>();
  if (raw === undefined) {
    return { kind: 'reprompt', result: await askForConfirmation() };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data.tool !== tool) {
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
    return { kind: 'reprompt', result: await askForConfirmation() };
  }

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
    return { kind: 'reprompt', result: await askForConfirmation() };
  }

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
