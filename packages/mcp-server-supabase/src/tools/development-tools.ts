import { z } from 'zod/v4';
import type { DevelopmentOperations } from '../platform/types.js';
import { generateTypescriptTypesResultSchema } from '../platform/types.js';
import { injectableTool, type ToolDefs } from './util.js';

type DevelopmentToolsOptions = {
  development: DevelopmentOperations;
  projectId?: string;
};

const getProjectUrlInputSchema = z.object({
  project_id: z.string(),
});

const getProjectUrlOutputSchema = z.object({
  url: z.string(),
});

const getPublishableKeysInputSchema = z.object({
  project_id: z.string(),
});

const getPublishableKeysOutputSchema = z.object({
  keys: z.array(
    z.object({
      api_key: z.string(),
      name: z.string(),
      type: z.enum(['legacy', 'publishable']),
      description: z.string().optional(),
      id: z.string().optional(),
      disabled: z.boolean().optional(),
    })
  ),
});

const generateTypescriptTypesInputSchema = z.object({
  project_id: z.string(),
  included_schemas: z
    .array(z.string())
    .optional()
    .describe(
      'List of schemas to include in the generated TypeScript types (e.g. ["public"]). When omitted, includes all exposed schemas.'
    ),
});

const generateTypescriptTypesOutputSchema = generateTypescriptTypesResultSchema;

export const developmentToolDefs = {
  get_project_url: {
    description: 'Gets the API URL for a project.',
    parameters: getProjectUrlInputSchema,
    outputSchema: getProjectUrlOutputSchema,
    annotations: {
      title: 'Get project URL',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_publishable_keys: {
    description:
      'Gets all publishable API keys for a project, including legacy anon keys (JWT-based) and modern publishable keys (format: sb_publishable_...). Publishable keys are recommended for new applications due to better security and independent rotation. Legacy anon keys are included for compatibility, as many LLMs are pretrained on them. Disabled keys are indicated by the "disabled" field; only use keys where disabled is false or undefined.',
    parameters: getPublishableKeysInputSchema,
    outputSchema: getPublishableKeysOutputSchema,
    annotations: {
      title: 'Get publishable keys',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  generate_typescript_types: {
    description: 'Generates TypeScript types for a project.',
    parameters: generateTypescriptTypesInputSchema,
    outputSchema: generateTypescriptTypesOutputSchema,
    annotations: {
      title: 'Generate TypeScript types',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getDevelopmentTools({
  development,
  projectId,
}: DevelopmentToolsOptions) {
  const project_id = projectId;

  return {
    get_project_url: injectableTool({
      ...developmentToolDefs.get_project_url,
      inject: { project_id },
      execute: async ({ project_id }) => {
        return { url: await development.getProjectUrl(project_id) };
      },
    }),
    get_publishable_keys: injectableTool({
      ...developmentToolDefs.get_publishable_keys,
      inject: { project_id },
      execute: async ({ project_id }) => {
        return { keys: await development.getPublishableKeys(project_id) };
      },
    }),
    generate_typescript_types: injectableTool({
      ...developmentToolDefs.generate_typescript_types,
      inject: { project_id },
      execute: async ({ project_id, included_schemas }) => {
        return development.generateTypescriptTypes(
          project_id,
          included_schemas
        );
      },
    }),
  };
}
