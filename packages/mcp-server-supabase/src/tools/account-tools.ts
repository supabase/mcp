import {
  inputRequired,
  inputResponse,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { type ObservationFact, tool } from '@supabase/mcp-utils';
import { z } from 'zod/v4';
import type { ToolDefs } from './util.js';
import {
  actionOnlyElicitationSchema,
  isFormCapable,
  type CostConfirmationState,
} from './cost-confirmation.js';
import type { AccountOperations } from '../platform/types.js';
import { organizationSchema, projectSchema } from '../platform/types.js';
import { getBranchCost, getNextProjectCost } from '../pricing.js';
import { AWS_REGION_CODES } from '../regions.js';
import { hashObject } from '../util.js';

type AccountToolsOptions = {
  account: AccountOperations;
  readOnly?: boolean;
  /**
   * Enables cost confirmation via elicitation inside `create_project` for
   * clients that declare per-request form capability (see
   * `isFormCapable`). Absent, `create_project` keeps requiring
   * `confirm_cost_id` from `confirm_cost` unchanged.
   */
  costConfirmation?: {
    codec: RequestStateCodec<CostConfirmationState>;
  };
};

const listOrganizationsInputSchema = z.object({});

const listOrganizationsOutputSchema = z.object({
  organizations: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
    })
  ),
});

const getOrganizationInputSchema = z.object({
  id: z.string().describe('The organization ID'),
});

const getOrganizationOutputSchema = organizationSchema;

const listProjectsInputSchema = z.object({});

const listProjectsOutputSchema = z.object({
  projects: z.array(projectSchema),
});

const getProjectInputSchema = z.object({
  id: z.string().describe('The project ID'),
});

const getProjectOutputSchema = projectSchema;

const getCostInputSchema = z.object({
  type: z.enum(['project', 'branch']),
  organization_id: z
    .string()
    .describe('The organization ID. Always ask the user.'),
});

const getCostOutputSchema = z.object({
  type: z.enum(['project', 'branch']),
  amount: z.number().describe('Cost in USD'),
  recurrence: z.enum(['hourly', 'monthly']),
});

const confirmCostInputSchema = z.object({
  type: z.enum(['project', 'branch']),
  recurrence: z.enum(['hourly', 'monthly']),
  amount: z.number(),
});

const confirmCostOutputSchema = z.object({
  confirmation_id: z.string(),
});

const createProjectInputSchema = z.object({
  name: z.string().describe('The name of the project'),
  region: z
    .enum(AWS_REGION_CODES)
    .describe('The region to create the project in.'),
  organization_id: z.string(),
  confirm_cost_id: z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? 'User must confirm understanding of costs before creating a project.'
          : undefined,
    })
    .describe('The cost confirmation ID. Call `confirm_cost` first.'),
});

const createProjectOutputSchema = projectSchema;

const createProjectInputSchemaWithElicitation = createProjectInputSchema.extend(
  {
    confirm_cost_id: z
      .string()
      .optional()
      .describe(
        'The cost confirmation ID. Only required for clients without per-request form-elicitation capability; those clients must call `confirm_cost` first. Form-capable clients are asked to confirm the cost inline when creating the project.'
      ),
  }
);

const pauseProjectInputSchema = z.object({
  project_id: z.string(),
});

const pauseProjectOutputSchema = z.object({
  success: z.boolean(),
});

const restoreProjectInputSchema = z.object({
  project_id: z.string(),
});

const restoreProjectOutputSchema = z.object({
  success: z.boolean(),
});

export const accountToolDefs = {
  list_organizations: {
    description: 'Lists all organizations that the user is a member of.',
    parameters: listOrganizationsInputSchema,
    outputSchema: listOrganizationsOutputSchema,
    annotations: {
      title: 'List organizations',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_organization: {
    description:
      'Gets details for an organization. Includes subscription plan.',
    parameters: getOrganizationInputSchema,
    outputSchema: getOrganizationOutputSchema,
    annotations: {
      title: 'Get organization details',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  list_projects: {
    description:
      'Lists all Supabase projects for the user. Use this to help discover the project ID of the project that the user is working on.',
    parameters: listProjectsInputSchema,
    outputSchema: listProjectsOutputSchema,
    annotations: {
      title: 'List projects',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_project: {
    description: 'Gets details for a Supabase project.',
    parameters: getProjectInputSchema,
    outputSchema: getProjectOutputSchema,
    annotations: {
      title: 'Get project details',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_cost: {
    description:
      'Gets the cost of creating a new project or branch. Never assume organization as costs can be different for each. Always repeat the cost to the user and confirm their understanding before proceeding.',
    parameters: getCostInputSchema,
    outputSchema: getCostOutputSchema,
    annotations: {
      title: 'Get cost of new resources',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  confirm_cost: {
    description:
      'Ask the user to confirm their understanding of the cost of creating a new project or branch. Call `get_cost` first. Returns a unique ID for this confirmation which should be passed to `create_project` or `create_branch`.',
    parameters: confirmCostInputSchema,
    outputSchema: confirmCostOutputSchema,
    annotations: {
      title: 'Confirm cost understanding',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  create_project: {
    description:
      'Creates a new Supabase project. Always ask the user which organization to create the project in. The project can take a few minutes to initialize - use `get_project` to check the status.',
    parameters: createProjectInputSchema,
    outputSchema: createProjectOutputSchema,
    annotations: {
      title: 'Create project',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  pause_project: {
    description: 'Pauses a Supabase project.',
    parameters: pauseProjectInputSchema,
    outputSchema: pauseProjectOutputSchema,
    annotations: {
      title: 'Pause project',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  restore_project: {
    description: 'Restores a Supabase project.',
    parameters: restoreProjectInputSchema,
    outputSchema: restoreProjectOutputSchema,
    annotations: {
      title: 'Restore project',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getAccountTools({
  account,
  readOnly,
  costConfirmation,
}: AccountToolsOptions) {
  return {
    list_organizations: tool({
      ...accountToolDefs.list_organizations,
      execute: async () => {
        return { organizations: await account.listOrganizations() };
      },
    }),
    get_organization: tool({
      ...accountToolDefs.get_organization,
      execute: async ({ id: organizationId }) => {
        return await account.getOrganization(organizationId);
      },
    }),
    list_projects: tool({
      ...accountToolDefs.list_projects,
      execute: async () => {
        return { projects: await account.listProjects() };
      },
    }),
    get_project: tool({
      ...accountToolDefs.get_project,
      execute: async ({ id }) => {
        return await account.getProject(id);
      },
    }),
    get_cost: tool({
      ...accountToolDefs.get_cost,
      execute: async ({ type, organization_id }) => {
        switch (type) {
          case 'project':
            return await getNextProjectCost(account, organization_id);
          case 'branch':
            return getBranchCost();
          default:
            throw new Error(`Unknown cost type: ${type}`);
        }
      },
    }),
    confirm_cost: tool({
      ...accountToolDefs.confirm_cost,
      execute: async (cost) => {
        return { confirmation_id: await hashObject(cost) };
      },
    }),
    create_project: tool({
      ...accountToolDefs.create_project,
      parameters: costConfirmation
        ? createProjectInputSchemaWithElicitation
        : createProjectInputSchema,
      execute: async (
        {
          name,
          region,
          organization_id,
          confirm_cost_id,
        }: z.infer<typeof createProjectInputSchemaWithElicitation>,
        ctx: ServerContext,
        record?: (fact: ObservationFact) => void
      ) => {
        if (readOnly) {
          record?.({
            kind: 'confirmation_decision',
            feature: 'cost',
            route: 'blocked',
            reason: 'read_only',
          });
          throw new Error('Cannot create a project in read-only mode.');
        }

        if (costConfirmation && isFormCapable(ctx)) {
          const { codec } = costConfirmation;
          const cost = await getNextProjectCost(account, organization_id);
          const state = ctx.mcpReq.requestState<CostConfirmationState>();
          if (!state && cost.amount === 0) {
            record?.({
              kind: 'confirmation_decision',
              feature: 'cost',
              route: 'bypass',
              reason: 'zero_cost',
            });
            const startedAt = record ? performance.now() : 0;
            record?.({
              kind: 'operation',
              feature: 'cost',
              disposition: 'started',
            });
            try {
              const result = await account.createProject({
                name,
                region,
                organization_id,
              });
              record?.({
                kind: 'operation',
                feature: 'cost',
                disposition: 'returned',
                durationMs: performance.now() - startedAt,
              });
              return result;
            } catch (error) {
              record?.({
                kind: 'operation',
                feature: 'cost',
                disposition: 'threw',
                durationMs: performance.now() - startedAt,
              });
              throw error;
            }
          }

          record?.({
            kind: 'confirmation_decision',
            feature: 'cost',
            route: 'inline',
            reason: 'eligible',
          });

          const costSuffix = cost.recurrence === 'monthly' ? '/month' : '/hr';

          const askForConfirmation = async (
            reason: 'initial' | 'missing_response' | 'changed_quote'
          ) => {
            const result = inputRequired({
              inputRequests: {
                confirm_cost: inputRequired.elicit({
                  mode: 'form',
                  message: [
                    `Project: $${cost.amount}${costSuffix} until deleted.`,
                    'Billed hourly while running; paused projects are not billed.',
                    'Standard rate, before plan allowances or exemptions.',
                  ].join('\n'),
                  requestedSchema: actionOnlyElicitationSchema,
                }),
              },
              requestState: await codec.mint(
                { tool: 'create_project', name, region, organization_id, cost },
                ctx
              ),
            });
            record?.({
              kind: 'input_required',
              feature: 'cost',
              mode: 'form',
              reason,
            });
            return result;
          };

          if (!state) {
            return askForConfirmation('initial');
          }

          if (state.tool !== 'create_project') {
            record?.({
              kind: 'resume_validation',
              feature: 'cost',
              result: 'tool_mismatch',
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Request state was not issued for create_project.',
                },
              ],
              structuredContent: { status: 'error' },
              isError: true,
            };
          }

          if (
            state.name !== name ||
            state.region !== region ||
            state.organization_id !== organization_id
          ) {
            record?.({
              kind: 'resume_validation',
              feature: 'cost',
              result: 'arguments_mismatch',
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Request state arguments do not match the current arguments.',
                },
              ],
              structuredContent: { status: 'error' },
              isError: true,
            };
          }

          const response = inputResponse(
            ctx.mcpReq.inputResponses,
            'confirm_cost'
          );
          if (response.kind !== 'elicit') {
            record?.({
              kind: 'resume_validation',
              feature: 'cost',
              result: 'missing_response',
            });
            return askForConfirmation('missing_response');
          }

          if (response.action === 'decline') {
            record?.({
              kind: 'input_response',
              feature: 'cost',
              action: 'decline',
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Project creation was declined.',
                },
              ],
              structuredContent: { status: 'declined' },
            };
          }

          if (response.action !== 'accept') {
            record?.({
              kind: 'input_response',
              feature: 'cost',
              action: 'cancel',
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Project creation was cancelled.',
                },
              ],
              structuredContent: { status: 'cancelled' },
            };
          }

          record?.({
            kind: 'input_response',
            feature: 'cost',
            action: 'accept',
          });

          if (
            cost.amount !== 0 &&
            (state.cost.type !== cost.type ||
              state.cost.recurrence !== cost.recurrence ||
              state.cost.amount !== cost.amount)
          ) {
            // Pricing changed since the state was minted (e.g. the org's
            // plan or active-project count shifted) - reissue a fresh
            // prompt bound to the recomputed cost rather than honoring a
            // stale quote.
            record?.({
              kind: 'resume_validation',
              feature: 'cost',
              result: 'changed_quote',
            });
            return askForConfirmation('changed_quote');
          }

          record?.({
            kind: 'resume_validation',
            feature: 'cost',
            result: 'valid',
          });
          const startedAt = record ? performance.now() : 0;
          record?.({
            kind: 'operation',
            feature: 'cost',
            disposition: 'started',
          });
          try {
            const result = await account.createProject({
              name: state.name,
              region: state.region,
              organization_id: state.organization_id,
            });
            record?.({
              kind: 'operation',
              feature: 'cost',
              disposition: 'returned',
              durationMs: performance.now() - startedAt,
            });
            return result;
          } catch (error) {
            record?.({
              kind: 'operation',
              feature: 'cost',
              disposition: 'threw',
              durationMs: performance.now() - startedAt,
            });
            throw error;
          }
        }

        const cost = await getNextProjectCost(account, organization_id);
        record?.({
          kind: 'confirmation_decision',
          feature: 'cost',
          route: 'legacy',
          reason: costConfirmation ? 'capability_missing' : 'not_configured',
        });
        const costHash = await hashObject(cost);
        if (costHash !== confirm_cost_id) {
          throw new Error(
            'Cost confirmation ID does not match the expected cost of creating a project.'
          );
        }

        const startedAt = record ? performance.now() : 0;
        record?.({
          kind: 'operation',
          feature: 'cost',
          disposition: 'started',
        });
        try {
          const result = await account.createProject({
            name,
            region,
            organization_id,
          });
          record?.({
            kind: 'operation',
            feature: 'cost',
            disposition: 'returned',
            durationMs: performance.now() - startedAt,
          });
          return result;
        } catch (error) {
          record?.({
            kind: 'operation',
            feature: 'cost',
            disposition: 'threw',
            durationMs: performance.now() - startedAt,
          });
          throw error;
        }
      },
    }),
    pause_project: tool({
      ...accountToolDefs.pause_project,
      execute: async ({ project_id }) => {
        if (readOnly) {
          throw new Error('Cannot pause a project in read-only mode.');
        }

        await account.pauseProject(project_id);
        return { success: true };
      },
    }),
    restore_project: tool({
      ...accountToolDefs.restore_project,
      execute: async ({ project_id }) => {
        if (readOnly) {
          throw new Error('Cannot restore a project in read-only mode.');
        }

        await account.restoreProject(project_id);
        return { success: true };
      },
    }),
  };
}
