import type { InitData } from '@supabase/mcp-utils';
import { z } from 'zod/v4';
import { AWS_REGION_CODES } from '../regions.js';

export type SuccessResponse = {
  success: true;
};

export const storageBucketSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  public: z.boolean(),
});

export const storageConfigSchema = z.object({
  fileSizeLimit: z.number().int().min(0).max(536_870_912_000), // 500GB
  features: z.object({
    imageTransformation: z.object({ enabled: z.boolean() }),
    s3Protocol: z.object({ enabled: z.boolean() }),
  }),
});

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.string().optional(),
  allowed_release_channels: z.array(z.string()),
  opt_in_tags: z.array(z.string()),
});

export const projectSchema = z.object({
  id: z.string(),
  ref: z.string(),
  organization_id: z.string(),
  organization_slug: z.string(),
  name: z.string(),
  status: z.string(),
  created_at: z.string(),
  region: z.string(),
});

export const branchSchema = z.object({
  id: z.string(),
  name: z.string(),
  project_ref: z.string(),
  parent_project_ref: z.string(),
  is_default: z.boolean(),
  git_branch: z.string().optional(),
  pr_number: z.number().optional(),
  latest_check_run_id: z.number().optional(),
  persistent: z.boolean(),
  status: z.enum([
    'CREATING_PROJECT',
    'RUNNING_MIGRATIONS',
    'MIGRATIONS_PASSED',
    'MIGRATIONS_FAILED',
    'FUNCTIONS_DEPLOYED',
    'FUNCTIONS_FAILED',
  ]),
  created_at: z.string(),
  updated_at: z.string(),
});

export const edgeFunctionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  version: z.number(),
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
  verify_jwt: z.boolean().optional(),
  import_map: z.boolean().optional(),
  import_map_path: z.string().optional(),
  entrypoint_path: z.string().optional(),
});

export const edgeFunctionWithBodySchema = edgeFunctionSchema.extend({
  files: z.array(
    z.object({
      name: z.string(),
      content: z.string(),
    })
  ),
});

export const createProjectOptionsSchema = z.object({
  name: z.string().min(1).max(256),
  organization_id: z.string(),
  region: z.enum(AWS_REGION_CODES),
  db_pass: z.string().optional(),
});

export const createBranchOptionsSchema = z.object({
  name: z.string().min(1),
});

export const resetBranchOptionsSchema = z.object({
  migration_version: z.string().optional(),
});

export const deployEdgeFunctionOptionsSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  entrypoint_path: z.string(),
  import_map_path: z.string().optional(),
  verify_jwt: z.boolean().optional(),
  files: z.array(
    z.object({
      name: z.string(),
      content: z.string(),
    })
  ),
});

export const executeSqlOptionsSchema = z.object({
  query: z.string().min(1),
  parameters: z.array(z.unknown()).optional(),
  read_only: z.boolean().optional(),
});

export const applyMigrationOptionsSchema = z.object({
  name: z.string().min(1),
  query: z.string().min(1),
});

export const migrationSchema = z.object({
  version: z.string(),
  name: z.string().optional(),
});

export const logsServiceSchema = z.enum([
  'api',
  'branch-action',
  'postgres',
  'edge-function',
  'edge-function-runtime',
  'auth',
  'storage',
  'realtime',
]);

export const getLogsOptionsSchema = z.object({
  service: logsServiceSchema,
  iso_timestamp_start: z.string().optional(),
  iso_timestamp_end: z.string().optional(),
});

export const queryLogsOptionsSchema = z.object({
  sql: z.string().min(1),
  iso_timestamp_start: z.string().optional(),
  iso_timestamp_end: z.string().optional(),
});

export const generateTypescriptTypesResultSchema = z.object({
  types: z.string(),
});

export type Organization = z.infer<typeof organizationSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type EdgeFunction = z.infer<typeof edgeFunctionSchema>;
export type EdgeFunctionWithBody = z.infer<typeof edgeFunctionWithBodySchema>;

export type CreateProjectOptions = z.infer<typeof createProjectOptionsSchema>;
export type CreateBranchOptions = z.infer<typeof createBranchOptionsSchema>;
export type ResetBranchOptions = z.infer<typeof resetBranchOptionsSchema>;
export type DeployEdgeFunctionOptions = z.infer<
  typeof deployEdgeFunctionOptionsSchema
>;

export type ExecuteSqlOptions = z.infer<typeof executeSqlOptionsSchema>;
export type ApplyMigrationOptions = z.infer<typeof applyMigrationOptionsSchema>;
export type Migration = z.infer<typeof migrationSchema>;
export type ListMigrationsResult = z.infer<typeof migrationSchema>;

export type LogsService = z.infer<typeof logsServiceSchema>;
export type GetLogsOptions = z.infer<typeof getLogsOptionsSchema>;
export type QueryLogsOptions = z.infer<typeof queryLogsOptionsSchema>;
export type GenerateTypescriptTypesResult = z.infer<
  typeof generateTypescriptTypesResultSchema
>;

export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type StorageBucket = z.infer<typeof storageBucketSchema>;

export type DatabaseOperations = {
  executeSql<T>(projectId: string, options: ExecuteSqlOptions): Promise<T[]>;
  listMigrations(projectId: string): Promise<Migration[]>;
  applyMigration(
    projectId: string,
    options: ApplyMigrationOptions
  ): Promise<void>;
};

export type AccountOperations = {
  listOrganizations(): Promise<{ id: string; slug: string; name: string }[]>;
  getOrganization(organizationId: string): Promise<Organization>;
  listProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project>;
  createProject(options: CreateProjectOptions): Promise<Project>;
  pauseProject(projectId: string): Promise<void>;
  restoreProject(projectId: string): Promise<void>;
};

export type EdgeFunctionsOperations = {
  listEdgeFunctions(projectId: string): Promise<EdgeFunction[]>;
  getEdgeFunction(
    projectId: string,
    functionSlug: string
  ): Promise<EdgeFunctionWithBody>;
  deployEdgeFunction(
    projectId: string,
    options: DeployEdgeFunctionOptions
  ): Promise<Omit<EdgeFunction, 'files'>>;
};

/**
 * SQL dialect that a platform's logs endpoint speaks. Selects the
 * dialect-appropriate `query_logs` description and `sql` parameter hint so a
 * single tool can roll out across environments that back logs with different
 * engines (hosted ClickHouse vs. self-hosted/CLI BigQuery).
 */
export type LogsDialect = 'clickhouse' | 'bigquery';

export type DebuggingOperations = {
  /**
   * SQL dialect accepted by `queryLogs`. Defaults to `'clickhouse'` when unset,
   * preserving the behavior of platforms that predate this field.
   */
  logsDialect?: LogsDialect;
  getLogs(projectId: string, options: GetLogsOptions): Promise<unknown>;
  queryLogs?(projectId: string, options: QueryLogsOptions): Promise<unknown>;
  getSecurityAdvisors(projectId: string): Promise<unknown>;
  getPerformanceAdvisors(projectId: string): Promise<unknown>;
  getHealthAdvisors(projectId: string): Promise<unknown>;
};

export const apiKeyTypeSchema = z.enum(['legacy', 'publishable']);
export type ApiKeyType = z.infer<typeof apiKeyTypeSchema>;

export type ApiKey = {
  api_key: string;
  name: string;
  type: ApiKeyType;
  description?: string;
  id?: string;
  disabled?: boolean;
};

export type DevelopmentOperations = {
  getProjectUrl(projectId: string): Promise<string>;
  getPublishableKeys(projectId: string): Promise<ApiKey[]>;
  generateTypescriptTypes(
    projectId: string
  ): Promise<GenerateTypescriptTypesResult>;
};

export type StorageOperations = {
  getStorageConfig(projectId: string): Promise<StorageConfig>;
  updateStorageConfig(projectId: string, config: StorageConfig): Promise<void>;
  listAllBuckets(projectId: string): Promise<StorageBucket[]>;
};

export type BranchingOperations = {
  listBranches(projectId: string): Promise<Branch[]>;
  createBranch(
    projectId: string,
    options: CreateBranchOptions
  ): Promise<Branch>;
  deleteBranch(branchId: string): Promise<void>;
  mergeBranch(branchId: string): Promise<void>;
  resetBranch(branchId: string, options: ResetBranchOptions): Promise<void>;
  rebaseBranch(branchId: string): Promise<void>;
};

export type SupabasePlatform = {
  init?(info: InitData): Promise<void>;
  account?: AccountOperations;
  database?: DatabaseOperations;
  functions?: EdgeFunctionsOperations;
  debugging?: DebuggingOperations;
  development?: DevelopmentOperations;
  storage?: StorageOperations;
  branching?: BranchingOperations;
};
