import { z } from 'zod/v4';
import { ToolCallerError } from '../errors.js';
import type { StorageOperations } from '../platform/types.js';
import { storageBucketSchema, storageConfigSchema } from '../platform/types.js';
import { injectableTool, type ToolDefs } from './util.js';

type StorageToolsOptions = {
  storage: StorageOperations;
  projectId?: string;
  readOnly?: boolean;
};

const listStorageBucketsInputSchema = z.object({
  project_id: z.string(),
});

const listStorageBucketsOutputSchema = z.object({
  buckets: z.array(storageBucketSchema),
});

const getStorageConfigInputSchema = z.object({
  project_id: z.string(),
});

const getStorageConfigOutputSchema = storageConfigSchema;

const updateStorageConfigInputSchema = z.object({
  project_id: z.string(),
  config: z.object({
    fileSizeLimit: z.number(),
    features: z.object({
      imageTransformation: z.object({ enabled: z.boolean() }),
      s3Protocol: z.object({ enabled: z.boolean() }),
    }),
  }),
});

const updateStorageConfigOutputSchema = z.object({
  success: z.boolean(),
});

export const storageToolDefs = {
  list_storage_buckets: {
    description: 'Lists all storage buckets in a Supabase project.',
    parameters: listStorageBucketsInputSchema,
    outputSchema: listStorageBucketsOutputSchema,
    annotations: {
      title: 'List storage buckets',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_storage_config: {
    description: 'Get the storage config for a Supabase project.',
    parameters: getStorageConfigInputSchema,
    outputSchema: getStorageConfigOutputSchema,
    annotations: {
      title: 'Get storage config',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  update_storage_config: {
    description: 'Update the storage config for a Supabase project.',
    parameters: updateStorageConfigInputSchema,
    outputSchema: updateStorageConfigOutputSchema,
    annotations: {
      title: 'Update storage config',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getStorageTools({
  storage,
  projectId,
  readOnly,
}: StorageToolsOptions) {
  const project_id = projectId;

  return {
    list_storage_buckets: injectableTool({
      ...storageToolDefs.list_storage_buckets,
      inject: { project_id },
      execute: async ({ project_id }) => {
        return { buckets: await storage.listAllBuckets(project_id) };
      },
    }),
    get_storage_config: injectableTool({
      ...storageToolDefs.get_storage_config,
      inject: { project_id },
      execute: async ({ project_id }) => {
        return await storage.getStorageConfig(project_id);
      },
    }),
    update_storage_config: injectableTool({
      ...storageToolDefs.update_storage_config,
      inject: { project_id },
      execute: async ({ project_id, config }) => {
        if (readOnly) {
          throw new ToolCallerError(
            'Cannot update storage config in read-only mode.'
          );
        }

        await storage.updateStorageConfig(project_id, config);
        return { success: true };
      },
    }),
  };
}
