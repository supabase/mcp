import {
  CLIENT_CAPABILITIES_META_KEY,
  inputResponse,
  PROTOCOL_VERSION_META_KEY,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { ToolObservation } from '@supabase/mcp-utils';
import type { ConfirmationFeature, ObservationFact } from '../observation.js';
import { z } from 'zod/v4';
import type { BranchCost, Cost } from '../pricing.js';
import { AWS_REGION_CODES } from '../regions.js';

/** `confirm_cost_id` description for clients that must call `confirm_cost`. */
export const confirmCostIdDescription =
  'The ID returned by `confirm_cost`. To get it, call `get_cost`, tell the user the cost, and call `confirm_cost` once they agree.';

/** `confirm_cost_id` description when the create tool can also confirm inline. */
export const optionalConfirmCostIdDescription = `${confirmCostIdDescription} Only needed when a call without it returns an error asking for it.`;

/**
 * Shared by `create_project` and `create_branch`. Clients that read a cached
 * tool list (e.g. OpenAI's connector) may get another client shape's schema,
 * so the wording works for all shapes: the model calls first and the server
 * either shows its own cost form or asks for a `confirm_cost_id`. Asking in
 * chat first would make form-capable clients confirm twice.
 */
export const callBeforeConfirmingDescription =
  'Unless `confirm_cost_id` is required, call this tool without it and without asking for cost confirmation in chat first. The server handles cost confirmation, or returns instructions for obtaining a confirmation ID. If it requests an ID, follow those instructions and retry with it.';

/** Returned when a create tool needs a `confirm_cost_id` the call left out. */
export const missingConfirmCostIdMessage =
  'This client needs a cost confirmation ID: call `get_cost`, tell the user the cost, call `confirm_cost` once they agree, then retry with its `confirmation_id` as `confirm_cost_id`.';

/**
 * Epoch ms (`Date.now()`) when a confirmation was sent; each prompt mints a
 * fresh one. Optional because states minted before it existed lack it.
 */
type IssuedAt = number;
const issuedAtSchema = z.number().optional();

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
  issued_at?: IssuedAt;
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
  issued_at: issuedAtSchema,
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
  issued_at?: IssuedAt;
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
  issued_at: issuedAtSchema,
}) satisfies z.ZodType<BranchCostState>;

export type ExecuteSqlState = {
  tool: 'execute_sql';
  project_id: string;
  queryHash: string;
  issued_at?: IssuedAt;
};

export type ApplyMigrationState = {
  tool: 'apply_migration';
  project_id: string;
  name: string;
  queryHash: string;
  issued_at?: IssuedAt;
};

/**
 * Signed `requestState` payload for the `run_notebook` confirmation, bound to
 * the notebook, execution mode and a hash of the query cells shown to the user.
 */
export type RunNotebookState = {
  tool: 'run_notebook';
  project_id: string;
  notebook_id: string;
  cellsHash: string;
  readOnly: boolean;
  issued_at?: IssuedAt;
};

export type DestructiveSqlState = ExecuteSqlState | ApplyMigrationState;
export type CostConfirmationState = ProjectCostState | BranchCostState;

/**
 * Signed `requestState` payload for any confirmation elicitation this server
 * issues, discriminated by `tool`.
 */
export type ConfirmationState =
  | CostConfirmationState
  | DestructiveSqlState
  | RunNotebookState;

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
  issued_at: issuedAtSchema,
}) satisfies z.ZodType<ExecuteSqlState>;

export const applyMigrationStateSchema = z.object({
  tool: z.literal('apply_migration'),
  project_id: z.string(),
  name: z.string(),
  queryHash: z.string(),
  issued_at: issuedAtSchema,
}) satisfies z.ZodType<ApplyMigrationState>;

export const runNotebookStateSchema = z.object({
  tool: z.literal('run_notebook'),
  project_id: z.string(),
  notebook_id: z.string(),
  cellsHash: z.string(),
  readOnly: z.boolean(),
  issued_at: issuedAtSchema,
}) satisfies z.ZodType<RunNotebookState>;

export type CheckConfirmationStateResult =
  | { kind: 'proceed' }
  | { kind: 'reprompt'; result: InputRequiredResult }
  | { kind: 'terminal'; result: CallToolResult };

export type ConfirmationStateOptions<S extends ConfirmationState> = {
  ctx: ServerContext;
  tool: S['tool'];
  schema: z.ZodType<S>;
  requestKey: string;
  argsMatch: (state: S) => boolean;
  payloadMatch?: (state: S) => boolean;
  declinedText: string;
  /**
   * `Date.now()` sampled when the request reached the tool handler, before any
   * await, so server-side work doesn't count as client time.
   */
  receivedAt: number;
  observation?: ToolObservation<ObservationFact>;
};

type RepromptReason = 'initial' | 'missing_response' | 'changed_quote';

const OUTCOME = {
  accept: 'completed',
  decline: 'declined',
  cancel: 'cancelled',
} as const;

type ConfirmationDecision<S extends ConfirmationState> =
  | { kind: 'proceed'; state: S }
  | { kind: 'reprompt'; reason: RepromptReason }
  | { kind: 'terminal'; result: CallToolResult };

const FEATURE = {
  create_project: 'cost',
  create_branch: 'cost',
  execute_sql: 'destructive_sql',
  apply_migration: 'destructive_sql',
  run_notebook: 'notebook',
} as const satisfies Record<ConfirmationState['tool'], ConfirmationFeature>;

// SU-495524 logs show ~0.55 s client auto-cancels; nobody reads SQL and answers in < 1 s.
// Telemetry only: marks `instant` on the input_response fact, never changes the result.
const INSTANT_CANCEL_MS = 1000;

/** A terminal result carrying its message in both `content` and `structuredContent`. */
function terminalResult(
  status: 'declined' | 'cancelled' | 'error',
  message: string,
  isError = false
): CallToolResult {
  const structuredContent = { status, message };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

export async function checkConfirmationState<S extends ConfirmationState>(
  options: ConfirmationStateOptions<S> & {
    askForConfirmation: () => Promise<InputRequiredResult>;
  }
): Promise<
  CheckConfirmationStateResult &
    (
      | { kind: 'proceed'; state: S }
      | { kind: 'reprompt' }
      | { kind: 'terminal' }
    )
> {
  const decision = inspectConfirmationState(options);
  if (decision.kind !== 'reprompt') {
    return decision;
  }
  const result = await options.askForConfirmation();
  options.observation?.record({
    kind: 'input_required',
    feature: FEATURE[options.tool],
    mode: 'form',
    reason: decision.reason,
  });
  return { kind: 'reprompt', result };
}

/** Inspect SDK-verified state without issuing a new confirmation. */
export function inspectConfirmationState<S extends ConfirmationState>(
  options: ConfirmationStateOptions<S>
): ConfirmationDecision<S> {
  const {
    ctx,
    tool,
    schema,
    requestKey,
    argsMatch,
    payloadMatch,
    declinedText,
    observation,
    receivedAt,
  } = options;
  const feature = FEATURE[tool];
  const raw = ctx.mcpReq.requestState<unknown>();
  if (raw === undefined) {
    return { kind: 'reprompt', reason: 'initial' };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data.tool !== tool) {
    // Only a different tool's state counts as tool_mismatch.
    const rawTool = z.object({ tool: z.string() }).safeParse(raw).data?.tool;
    if (rawTool !== undefined && rawTool !== tool) {
      observation?.record({
        kind: 'resume_validation',
        feature,
        result: 'tool_mismatch',
      });
    }
    return {
      kind: 'terminal',
      result: terminalResult(
        'error',
        `Request state was not issued for ${tool}.`,
        true
      ),
    };
  }

  const state = parsed.data;
  if (!argsMatch(state)) {
    observation?.record({
      kind: 'resume_validation',
      feature,
      result: 'arguments_mismatch',
    });
    return {
      kind: 'terminal',
      result: terminalResult(
        'error',
        'Request state arguments do not match the current arguments.',
        true
      ),
    };
  }

  const response = inputResponse(ctx.mcpReq.inputResponses, requestKey);
  if (response.kind !== 'elicit') {
    observation?.record({
      kind: 'resume_validation',
      feature,
      result: 'missing_response',
    });
    return { kind: 'reprompt', reason: 'missing_response' };
  }

  // Missing (older state) or negative (clock skew) gaps carry no timing.
  const gap =
    state.issued_at === undefined ? undefined : receivedAt - state.issued_at;
  const elapsedMs = gap !== undefined && gap >= 0 ? gap : undefined;
  const instant =
    response.action === 'cancel' &&
    elapsedMs !== undefined &&
    elapsedMs < INSTANT_CANCEL_MS;

  observation?.setOutcome(OUTCOME[response.action]);
  observation?.record({
    kind: 'input_response',
    feature,
    action: response.action,
    ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
    ...(instant ? { instant: true } : {}),
  });

  if (response.action === 'decline') {
    return {
      kind: 'terminal',
      result: terminalResult('declined', declinedText),
    };
  }

  if (response.action !== 'accept') {
    const timing =
      elapsedMs === undefined
        ? ''
        : `The client cancelled this confirmation ${(Math.round(elapsedMs / 100) / 10).toFixed(1)} s after it was sent. `;
    return {
      kind: 'terminal',
      result: terminalResult(
        'cancelled',
        `${timing}Nothing was run. If you didn't see a confirmation prompt, your client may have cancelled it automatically.`
      ),
    };
  }

  if (payloadMatch && !payloadMatch(state)) {
    observation?.record({
      kind: 'resume_validation',
      feature,
      result: 'changed_quote',
    });
    return { kind: 'reprompt', reason: 'changed_quote' };
  }

  observation?.record({
    kind: 'resume_validation',
    feature,
    result: 'valid',
  });
  return { kind: 'proceed', state };
}

/** Records only the duration and disposition of the actual backend operation. */
export function observeOperation<T>(
  feature: ConfirmationFeature,
  record:
    | ((fact: Extract<ObservationFact, { kind: 'operation' }>) => void)
    | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (!record) {
    return run();
  }
  record({ kind: 'operation', feature, disposition: 'started' });
  const startedAt = performance.now();
  return (async () => {
    try {
      const result = await run();
      record({
        kind: 'operation',
        feature,
        disposition: 'returned',
        durationMs: performance.now() - startedAt,
      });
      return result;
    } catch (error) {
      record({
        kind: 'operation',
        feature,
        disposition: 'threw',
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  })();
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
