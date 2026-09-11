import {
  inputRequired,
  inputResponse,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { SecretOperations } from '../platform/types.js';
import {
  isUrlCapable,
  type CostConfirmationState,
} from './cost-confirmation.js';
import { injectableTool, type ToolDefs } from './util.js';

const RESUME_WINDOW_SECONDS = 600;

/** Fills `{ref}` and `{name}` in a connect URL template, percent-encoding each value. */
export function buildConnectUrl(
  template: string,
  ref: string,
  name: string
): string {
  return template
    .replaceAll('{ref}', encodeURIComponent(ref))
    .replaceAll('{name}', encodeURIComponent(name));
}

type SecretToolsOptions = {
  secrets: SecretOperations;
  projectId?: string;
  readOnly?: boolean;
  codec: RequestStateCodec<CostConfirmationState>;
  connectUrlTemplate: string;
};

const createEdgeFunctionSecretInputSchema = z.object({
  project_id: z.string(),
  name: z
    .string()
    .max(256)
    .regex(/\S/)
    .refine((n) => !n.startsWith('SUPABASE_'), {
      message: 'Secret names starting with SUPABASE_ are reserved.',
    }),
  replace: z
    .boolean()
    .optional()
    .describe(
      'Set to true to ask the user for a new value even if this secret was updated in the last 10 minutes. Default false: a recent update is reported as stored without asking again.'
    ),
});

const createEdgeFunctionSecretOutputSchema = z.object({
  name: z.string().optional(),
  stored: z.boolean().optional(),
  updated_seconds_ago: z.number().optional(),
  status: z.string().optional(),
});

export const secretToolDefs = {
  create_edge_function_secret: {
    description:
      'Creates or updates an Edge Function secret for the project. The user enters the value in the Supabase dashboard; it never passes through the AI client.',
    parameters: createEdgeFunctionSecretInputSchema,
    outputSchema: createEdgeFunctionSecretOutputSchema,
    annotations: {
      title: 'Create Edge Function secret',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getSecretTools({
  secrets,
  projectId,
  readOnly,
  codec,
  connectUrlTemplate,
}: SecretToolsOptions) {
  const project_id = projectId;

  return {
    create_edge_function_secret: injectableTool({
      ...secretToolDefs.create_edge_function_secret,
      inject: { project_id },
      execute: async (
        {
          project_id,
          name,
          replace,
        }: z.infer<typeof createEdgeFunctionSecretInputSchema>,
        ctx: ServerContext
      ) => {
        if (readOnly) {
          throw new Error('Cannot create a secret in read-only mode.');
        }

        const issue = async (issued_at: number) =>
          inputRequired({
            inputRequests: {
              store_secret: inputRequired.elicitUrl({
                message: [
                  `Add the value for secret ${name} in the Supabase dashboard.`,
                  'Only continue if you asked your AI client to store this secret.',
                  'Return here and confirm once it is stored.',
                ].join('\n'),
                url: buildConnectUrl(connectUrlTemplate, project_id, name),
              }),
            },
            requestState: await codec.mint(
              {
                tool: 'create_edge_function_secret',
                project_id,
                name,
                issued_at,
              },
              ctx
            ),
          });

        const state = ctx.mcpReq.requestState<CostConfirmationState>();
        if (!state) {
          if (!isUrlCapable(ctx)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'This client cannot open a browser page. Add the secret in the dashboard under Edge Functions > Secrets.',
                },
              ],
              structuredContent: { status: 'unsupported_client' },
              isError: true,
            };
          }
          const updatedAt = await secrets.getUpdatedAt(project_id, name);
          if (!replace && updatedAt) {
            const ageMs = Date.now() - updatedAt.getTime();
            if (ageMs >= 0 && ageMs <= RESUME_WINDOW_SECONDS * 1000) {
              const updated_seconds_ago = Math.floor(ageMs / 1000);
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `The dashboard reports an update to ${name} ${updated_seconds_ago} seconds ago.`,
                  },
                ],
                structuredContent: {
                  name,
                  stored: true,
                  updated_seconds_ago,
                },
              };
            }
          }

          // Floor to whole seconds: platform reports updated_at at second precision
          const issued_at = Math.floor(Date.now() / 1000) * 1000;
          return issue(issued_at);
        }

        if (state.tool !== 'create_edge_function_secret') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Request state was not issued for create_edge_function_secret.',
              },
            ],
            structuredContent: { status: 'error' },
            isError: true,
          };
        }

        if (state.project_id !== project_id || state.name !== name) {
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
          'store_secret'
        );
        if (response.kind !== 'elicit') {
          return issue(state.issued_at);
        }

        if (response.action === 'decline') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Not confirmed. If you already saved it in the dashboard, it is stored.',
              },
            ],
            structuredContent: { status: 'declined' },
          };
        }

        if (response.action !== 'accept') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Not confirmed. If you already saved it in the dashboard, it is stored.',
              },
            ],
            structuredContent: { status: 'cancelled' },
          };
        }

        const updatedAt = await secrets.getUpdatedAt(project_id, name);
        if (updatedAt && updatedAt.getTime() >= state.issued_at) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `The dashboard reports an update to ${name} since this request.`,
              },
            ],
            structuredContent: { name, stored: true },
          };
        }

        return issue(state.issued_at);
      },
    }),
  };
}
