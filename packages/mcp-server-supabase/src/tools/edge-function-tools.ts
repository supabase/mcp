import { z } from 'zod/v4';
import { edgeFunctionExample } from '../edge-function.js';
import { ToolCallerError } from '../errors.js';
import type { EdgeFunctionsOperations } from '../platform/types.js';
import {
  edgeFunctionSchema,
  edgeFunctionWithBodySchema,
} from '../platform/types.js';
import { injectableTool, type ToolDefs } from './util.js';

type EdgeFunctionToolsOptions = {
  functions: EdgeFunctionsOperations;
  projectId?: string;
  readOnly?: boolean;
};

const listEdgeFunctionsInputSchema = z.object({
  project_id: z.string(),
});

const listEdgeFunctionsOutputSchema = z.object({
  functions: z.array(edgeFunctionSchema),
});

const getEdgeFunctionInputSchema = z.object({
  project_id: z.string(),
  function_slug: z.string(),
});

const getEdgeFunctionOutputSchema = edgeFunctionWithBodySchema;

const deployEdgeFunctionInputSchema = z.object({
  project_id: z.string(),
  name: z.string().describe('The name of the function'),
  entrypoint_path: z
    .string()
    .default('index.ts')
    .describe('The entrypoint of the function'),
  import_map_path: z
    .string()
    .describe('The import map for the function.')
    .optional(),
  verify_jwt: z
    .boolean()
    .default(true)
    .describe(
      'Whether to require a valid JWT in the Authorization header. Keep this `true` unless the user asks to turn it off, the function previously had it turned off, or the function body does its own authentication (e.g. API keys, webhooks).'
    ),
  files: z
    .array(
      z.object({
        name: z.string(),
        content: z.string(),
      })
    )
    .describe(
      'The files to upload. This should include the entrypoint, deno.json, and any relative dependencies. Include the deno.json and deno.jsonc files to configure the Deno runtime (e.g., compiler options, imports) if they exist.'
    ),
});

const deployEdgeFunctionOutputSchema = edgeFunctionSchema;

export const edgeFunctionToolDefs = {
  list_edge_functions: {
    description: 'Lists all Edge Functions in a Supabase project.',
    parameters: listEdgeFunctionsInputSchema,
    outputSchema: listEdgeFunctionsOutputSchema,
    annotations: {
      title: 'List Edge Functions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_edge_function: {
    description:
      'Retrieves file contents for an Edge Function in a Supabase project.',
    parameters: getEdgeFunctionInputSchema,
    outputSchema: getEdgeFunctionOutputSchema,
    annotations: {
      title: 'Get Edge Function',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  deploy_edge_function: {
    description: `Deploys an Edge Function to a Supabase project. If a function with this name already exists, this replaces it with a new version that starts serving requests at the function's public URL right away. Example:\n\n${edgeFunctionExample}`,
    parameters: deployEdgeFunctionInputSchema,
    outputSchema: deployEdgeFunctionOutputSchema,
    annotations: {
      title: 'Deploy Edge Function',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getEdgeFunctionTools({
  functions,
  projectId,
  readOnly,
}: EdgeFunctionToolsOptions) {
  const project_id = projectId;

  return {
    list_edge_functions: injectableTool({
      ...edgeFunctionToolDefs.list_edge_functions,
      inject: { project_id },
      execute: async ({ project_id }) => {
        return { functions: await functions.listEdgeFunctions(project_id) };
      },
    }),
    get_edge_function: injectableTool({
      ...edgeFunctionToolDefs.get_edge_function,
      inject: { project_id },
      execute: async ({ project_id, function_slug }) => {
        return await functions.getEdgeFunction(project_id, function_slug);
      },
    }),
    deploy_edge_function: injectableTool({
      ...edgeFunctionToolDefs.deploy_edge_function,
      inject: { project_id },
      execute: async ({
        project_id,
        name,
        entrypoint_path,
        import_map_path,
        verify_jwt,
        files,
      }) => {
        if (readOnly) {
          throw new ToolCallerError(
            'Cannot deploy an edge function in read-only mode.'
          );
        }

        return await functions.deployEdgeFunction(project_id, {
          name,
          entrypoint_path,
          import_map_path,
          verify_jwt,
          files,
        });
      },
    }),
  };
}
