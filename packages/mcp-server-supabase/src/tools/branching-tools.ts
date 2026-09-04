import {
  inputRequired,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { tool } from '@supabase/mcp-utils';
import { z } from 'zod/v4';
import type { BranchingOperations } from '../platform/types.js';
import { branchSchema } from '../platform/types.js';
import { getBranchCost } from '../pricing.js';
import { hashObject } from '../util.js';
import {
  actionOnlyElicitationSchema,
  branchCostStateSchema,
  checkConfirmationState,
  isFormCapable,
  type ConfirmationState,
} from './confirmation.js';
import { injectableTool, type ToolDefs } from './util.js';

type BranchingToolsOptions = {
  branching: BranchingOperations;
  projectId?: string;
  readOnly?: boolean;
  /**
   * Enables confirmation via elicitation inside `create_branch` for clients
   * that declare per-request form capability (see `isFormCapable`). Absent,
   * `create_branch` keeps requiring `confirm_cost_id` from `confirm_cost`
   * unchanged.
   */
  confirmation?: {
    codec: RequestStateCodec<ConfirmationState>;
  };
};

const createBranchInputSchema = z.object({
  project_id: z.string(),
  name: z.string().default('develop').describe('Name of the branch to create'),
  confirm_cost_id: z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? 'User must confirm understanding of costs before creating a branch.'
          : undefined,
    })
    .describe('The cost confirmation ID. Call `confirm_cost` first.'),
});

const createBranchInputSchemaWithElicitation = createBranchInputSchema.extend({
  confirm_cost_id: z
    .string()
    .optional()
    .describe(
      'The cost confirmation ID. Only required for clients without per-request form-elicitation capability; those clients must call `confirm_cost` first. Form-capable clients are asked to confirm the cost inline when creating the branch.'
    ),
});

const createBranchOutputSchema = branchSchema;

const listBranchesInputSchema = z.object({
  project_id: z.string(),
});

const listBranchesOutputSchema = z.object({
  branches: z.array(branchSchema),
});

const deleteBranchInputSchema = z.object({
  branch_id: z.string(),
});

const deleteBranchOutputSchema = z.object({
  success: z.boolean(),
});

const mergeBranchInputSchema = z.object({
  branch_id: z.string(),
});

const mergeBranchOutputSchema = z.object({
  success: z.boolean(),
});

const resetBranchInputSchema = z.object({
  branch_id: z.string(),
  migration_version: z
    .string()
    .optional()
    .describe('Reset your development branch to a specific migration version.'),
});

const resetBranchOutputSchema = z.object({
  success: z.boolean(),
});

const rebaseBranchInputSchema = z.object({
  branch_id: z.string(),
});

const rebaseBranchOutputSchema = z.object({
  success: z.boolean(),
});

export const branchingToolDefs = {
  create_branch: {
    description:
      'Creates a development branch on a Supabase project. This will apply all migrations from the main project to a fresh branch database. Note that production data will not carry over. The branch will get its own project_id via the resulting project_ref. Use this ID to execute queries and migrations on the branch.',
    parameters: createBranchInputSchema,
    outputSchema: createBranchOutputSchema,
    annotations: {
      title: 'Create branch',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  list_branches: {
    description:
      'Lists all development branches of a Supabase project. This will return branch details including status which you can use to check when operations like merge/rebase/reset complete.',
    parameters: listBranchesInputSchema,
    outputSchema: listBranchesOutputSchema,
    annotations: {
      title: 'List branches',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  delete_branch: {
    description: 'Deletes a development branch.',
    parameters: deleteBranchInputSchema,
    outputSchema: deleteBranchOutputSchema,
    annotations: {
      title: 'Delete branch',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  merge_branch: {
    description:
      'Merges migrations and edge functions from a development branch to production.',
    parameters: mergeBranchInputSchema,
    outputSchema: mergeBranchOutputSchema,
    annotations: {
      title: 'Merge branch',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  reset_branch: {
    description:
      'Resets migrations of a development branch. Any untracked data or schema changes will be lost.',
    parameters: resetBranchInputSchema,
    outputSchema: resetBranchOutputSchema,
    annotations: {
      title: 'Reset branch',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  rebase_branch: {
    description:
      'Rebases a development branch on production. This will effectively run any newer migrations from production onto this branch to help handle migration drift.',
    parameters: rebaseBranchInputSchema,
    outputSchema: rebaseBranchOutputSchema,
    annotations: {
      title: 'Rebase branch',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getBranchingTools({
  branching,
  projectId,
  readOnly,
  confirmation,
}: BranchingToolsOptions) {
  const project_id = projectId;

  return {
    create_branch: injectableTool({
      ...branchingToolDefs.create_branch,
      parameters: confirmation
        ? createBranchInputSchemaWithElicitation
        : createBranchInputSchema,
      inject: { project_id },
      execute: async (
        {
          project_id,
          name,
          confirm_cost_id,
        }: z.infer<typeof createBranchInputSchemaWithElicitation>,
        ctx: ServerContext
      ) => {
        if (readOnly) {
          throw new Error('Cannot create a branch in read-only mode.');
        }

        if (confirmation && isFormCapable(ctx)) {
          const { codec } = confirmation;
          const cost = getBranchCost();
          const costSuffix = { hourly: '/hr' }[cost.recurrence];

          const askForConfirmation = async () =>
            inputRequired({
              inputRequests: {
                confirm_cost: inputRequired.elicit({
                  mode: 'form',
                  message: [
                    `Preview branch: $${cost.amount}${costSuffix} until deleted (~$${(cost.amount * 24 * 30).toFixed(2)} per 30 days).`,
                    'Auto-pauses on inactivity.',
                    'Standard rate, before plan allowances or exemptions.',
                  ].join('\n'),
                  requestedSchema: actionOnlyElicitationSchema,
                }),
              },
              requestState: await codec.mint(
                { tool: 'create_branch', project_id, name, cost },
                ctx
              ),
            });

          const confirmationState = await checkConfirmationState({
            ctx,
            tool: 'create_branch',
            schema: branchCostStateSchema,
            requestKey: 'confirm_cost',
            askForConfirmation,
            argsMatch: (state) =>
              state.project_id === project_id && state.name === name,
            payloadMatch: (state) =>
              state.cost.type === cost.type &&
              state.cost.recurrence === cost.recurrence &&
              state.cost.amount === cost.amount,
            declinedText: 'Branch creation was declined.',
            cancelledText: 'Branch creation was cancelled.',
          });

          switch (confirmationState.kind) {
            case 'reprompt':
            case 'terminal':
              return confirmationState.result;
            case 'proceed':
              return await branching.createBranch(
                confirmationState.state.project_id,
                { name: confirmationState.state.name }
              );
          }
        }

        const cost = getBranchCost();
        const costHash = await hashObject(cost);
        if (costHash !== confirm_cost_id) {
          throw new Error(
            'Cost confirmation ID does not match the expected cost of creating a branch.'
          );
        }
        return await branching.createBranch(project_id, { name });
      },
    }),
    list_branches: injectableTool({
      ...branchingToolDefs.list_branches,
      inject: { project_id },
      execute: async ({ project_id }) => {
        return { branches: await branching.listBranches(project_id) };
      },
    }),
    delete_branch: tool({
      ...branchingToolDefs.delete_branch,
      execute: async ({ branch_id }) => {
        if (readOnly) {
          throw new Error('Cannot delete a branch in read-only mode.');
        }

        await branching.deleteBranch(branch_id);
        return { success: true };
      },
    }),
    merge_branch: tool({
      ...branchingToolDefs.merge_branch,
      execute: async ({ branch_id }) => {
        if (readOnly) {
          throw new Error('Cannot merge a branch in read-only mode.');
        }

        await branching.mergeBranch(branch_id);
        return { success: true };
      },
    }),
    reset_branch: tool({
      ...branchingToolDefs.reset_branch,
      execute: async ({ branch_id, migration_version }) => {
        if (readOnly) {
          throw new Error('Cannot reset a branch in read-only mode.');
        }

        await branching.resetBranch(branch_id, {
          migration_version,
        });
        return { success: true };
      },
    }),
    rebase_branch: tool({
      ...branchingToolDefs.rebase_branch,
      execute: async ({ branch_id }) => {
        if (readOnly) {
          throw new Error('Cannot rebase a branch in read-only mode.');
        }

        await branching.rebaseBranch(branch_id);
        return { success: true };
      },
    }),
  };
}
