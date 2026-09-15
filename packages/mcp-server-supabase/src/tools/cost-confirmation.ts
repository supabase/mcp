import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { BranchCost, Cost } from '../pricing.js';
import type { AWS_REGION_CODES } from '../regions.js';

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

/**
 * Signed `requestState` payload for any cost-confirmation elicitation this
 * server issues, discriminated by `tool`.
 */
export type CostConfirmationState =
  | ProjectCostState
  | BranchCostState
  | SecretCollectionState;

/**
 * Signed `requestState` payload for the `create_edge_function_secret`
 * secret-collection elicitation, bound to the project and secret name. The
 * `issued_at` timestamp is preserved across reissues.
 */
export type SecretCollectionState = {
  tool: 'create_edge_function_secret';
  project_id: string;
  name: string;
  /** Epoch ms, floored to the second; the platform reports updated_at at second precision. */
  issued_at: number;
};

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
