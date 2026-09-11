import {
  getMultipartBoundary,
  parseMultipartStream,
} from '@mjackson/multipart-parser';
import type { InitData } from '@supabase/mcp-utils';
import { fileURLToPath } from 'node:url';
import packageJson from '../../package.json' with { type: 'json' };
import { getDeploymentId, normalizeFilename } from '../edge-function.js';
import { getClickHouseLogQuery } from '../logs.js';
import {
  assertProjectScopedSuccess,
  assertSuccess,
  createManagementApiClient,
} from '../management-api/index.js';
import { generatePassword } from '../password.js';
import {
  applyMigrationOptionsSchema,
  createBranchOptionsSchema,
  createProjectOptionsSchema,
  deployEdgeFunctionOptionsSchema,
  executeSqlOptionsSchema,
  getLogsOptionsSchema,
  queryLogsOptionsSchema,
  resetBranchOptionsSchema,
  type AccountOperations,
  type ApiKey,
  type ApiKeyType,
  type ApplyMigrationOptions,
  type BranchingOperations,
  type CreateBranchOptions,
  type CreateProjectOptions,
  type DatabaseOperations,
  type DebuggingOperations,
  type DeployEdgeFunctionOptions,
  type DevelopmentOperations,
  type SuccessResponse,
  type EdgeFunction,
  type EdgeFunctionsOperations,
  type EdgeFunctionWithBody,
  type ExecuteSqlOptions,
  type GetLogsOptions,
  type QueryLogsOptions,
  type ResetBranchOptions,
  type SecretOperations,
  type StorageConfig,
  type StorageOperations,
  type SupabasePlatform,
} from './index.js';

const { version } = packageJson;

const SUCCESS_RESPONSE: SuccessResponse = { success: true };

export type SupabaseApiPlatformOptions = {
  /**
   * The access token for the Supabase Management API.
   */
  accessToken: string;

  /**
   * The API URL for the Supabase Management API.
   */
  apiUrl?: string;
};

/**
 * Creates a Supabase platform implementation using the Supabase Management API.
 */
export function createSupabaseApiPlatform(
  options: SupabaseApiPlatformOptions
): SupabasePlatform {
  const { accessToken, apiUrl } = options;

  const managementApiUrl = apiUrl ?? 'https://api.supabase.com';

  let managementApiClient = createManagementApiClient(
    managementApiUrl,
    accessToken
  );

  const account: AccountOperations = {
    async listOrganizations() {
      const response = await managementApiClient.GET('/v1/organizations');

      assertSuccess(response, 'Failed to fetch organizations');

      return response.data;
    },
    async getOrganization(organizationId: string) {
      const response = await managementApiClient.GET(
        '/v1/organizations/{slug}',
        {
          params: {
            path: {
              slug: organizationId,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to fetch organization');

      return response.data;
    },
    async listProjects() {
      const response = await managementApiClient.GET('/v1/projects');

      assertSuccess(response, 'Failed to fetch projects');

      return response.data;
    },
    async getProject(projectId: string) {
      const response = await managementApiClient.GET('/v1/projects/{ref}', {
        params: {
          path: {
            ref: projectId,
          },
        },
      });
      assertSuccess(response, 'Failed to fetch project');
      return response.data;
    },
    async createProject(options: CreateProjectOptions) {
      const { name, organization_id, region, db_pass } =
        createProjectOptionsSchema.parse(options);

      const response = await managementApiClient.POST('/v1/projects', {
        body: {
          name,
          region,
          organization_slug: organization_id,
          db_pass:
            db_pass ??
            generatePassword({
              length: 16,
              numbers: true,
              uppercase: true,
              lowercase: true,
            }),
        },
      });

      assertSuccess(response, 'Failed to create project');

      return response.data;
    },
    async pauseProject(projectId: string) {
      const response = await managementApiClient.POST(
        '/v1/projects/{ref}/pause',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to pause project');
    },
    async restoreProject(projectId: string) {
      const response = await managementApiClient.POST(
        '/v1/projects/{ref}/restore',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to restore project');
    },
  };

  const database: DatabaseOperations = {
    async executeSql<T>(projectId: string, options: ExecuteSqlOptions) {
      const { query, parameters, read_only } =
        executeSqlOptionsSchema.parse(options);

      const response = await managementApiClient.POST(
        '/v1/projects/{ref}/database/query',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
          body: {
            query,
            parameters,
            read_only,
          },
        }
      );

      assertProjectScopedSuccess(
        response,
        'Failed to execute SQL query',
        projectId
      );

      return response.data as unknown as T[];
    },
    async listMigrations(projectId: string) {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/database/migrations',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
        }
      );

      assertProjectScopedSuccess(
        response,
        'Failed to fetch migrations',
        projectId
      );

      return response.data;
    },
    async applyMigration(projectId: string, options: ApplyMigrationOptions) {
      const { name, query } = applyMigrationOptionsSchema.parse(options);

      const response = await managementApiClient.POST(
        '/v1/projects/{ref}/database/migrations',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
          body: {
            name,
            query,
          },
        }
      );

      assertProjectScopedSuccess(
        response,
        'Failed to apply migration',
        projectId
      );

      // Intentionally don't return the result of the migration
      // to avoid prompt injection attacks. If the migration failed,
      // it will throw an error.
    },
  };

  const debugging: DebuggingOperations = {
    logsDialect: 'clickhouse',
    async getLogs(projectId: string, options: GetLogsOptions) {
      const { service, iso_timestamp_start, iso_timestamp_end } =
        getLogsOptionsSchema.parse(options);

      const sql = getClickHouseLogQuery(service);

      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/analytics/endpoints/logs',
        {
          params: {
            path: {
              ref: projectId,
            },
            query: {
              sql,
              iso_timestamp_start,
              iso_timestamp_end,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to fetch logs');

      return response.data;
    },
    async queryLogs(projectId: string, options: QueryLogsOptions) {
      const { sql, iso_timestamp_start, iso_timestamp_end } =
        queryLogsOptionsSchema.parse(options);

      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/analytics/endpoints/logs',
        {
          params: {
            path: {
              ref: projectId,
            },
            query: {
              sql,
              iso_timestamp_start,
              iso_timestamp_end,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to query logs');

      return response.data;
    },
    async getSecurityAdvisors(projectId: string) {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/advisors/security',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to fetch security advisors');

      return response.data;
    },
    async getPerformanceAdvisors(projectId: string) {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/advisors/performance',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to fetch performance advisors');

      return response.data;
    },
  };

  const development: DevelopmentOperations = {
    async getProjectUrl(projectId: string): Promise<string> {
      const apiUrl = new URL(managementApiUrl);
      return `https://${projectId}.${getProjectDomain(apiUrl.hostname)}`;
    },
    async getPublishableKeys(projectId: string): Promise<ApiKey[]> {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/api-keys',
        {
          params: {
            path: {
              ref: projectId,
            },
            query: {
              reveal: 'false',
            },
          },
        }
      );

      assertSuccess(response, 'Failed to fetch API keys');

      // Try to check if legacy JWT-based keys are enabled
      // If this fails, we'll continue without the disabled field
      let legacyKeysEnabled: boolean | undefined = undefined;
      try {
        const legacyKeysResponse = await managementApiClient.GET(
          '/v1/projects/{ref}/api-keys/legacy',
          {
            params: {
              path: {
                ref: projectId,
              },
            },
          }
        );

        if (legacyKeysResponse.response.ok) {
          legacyKeysEnabled = legacyKeysResponse.data?.enabled ?? true;
        }
      } catch (error) {
        // If we can't fetch legacy key status, continue without it
        legacyKeysEnabled = undefined;
      }

      // Filter for client-safe keys: legacy 'anon' or publishable type
      const clientKeys =
        response.data?.filter(
          (key) => key.name === 'anon' || key.type === 'publishable'
        ) ?? [];

      if (clientKeys.length === 0) {
        throw new Error(
          'No client-safe API keys (anon or publishable) found. Please create a publishable key in your project settings.'
        );
      }

      return clientKeys.map((key) => ({
        api_key: key.api_key!,
        name: key.name,
        type: (key.type === 'publishable'
          ? 'publishable'
          : 'legacy') satisfies ApiKeyType,
        // Only include disabled field if we successfully fetched legacy key status
        ...(legacyKeysEnabled !== undefined && {
          disabled: key.type === 'legacy' && !legacyKeysEnabled,
        }),
        description: key.description ?? undefined,
        id: key.id ?? undefined,
      }));
    },
    async generateTypescriptTypes(projectId: string) {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/types/typescript',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to fetch TypeScript types');

      return response.data;
    },
  };

  const functions: EdgeFunctionsOperations = {
    async listEdgeFunctions(projectId: string) {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/functions',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to fetch Edge Functions');

      return response.data.map((edgeFunction) => {
        const deploymentId = getDeploymentId(
          projectId,
          edgeFunction.id,
          edgeFunction.version
        );

        const entrypoint_path = edgeFunction.entrypoint_path
          ? normalizeFilename({
              deploymentId,
              filename: fileURLToPath(edgeFunction.entrypoint_path, {
                windows: false,
              }),
            })
          : undefined;

        const import_map_path = edgeFunction.import_map_path
          ? normalizeFilename({
              deploymentId,
              filename: fileURLToPath(edgeFunction.import_map_path, {
                windows: false,
              }),
            })
          : undefined;

        return {
          ...edgeFunction,
          entrypoint_path,
          import_map_path,
        };
      });
    },
    async getEdgeFunction(projectId: string, functionSlug: string) {
      const functionResponse = await managementApiClient.GET(
        '/v1/projects/{ref}/functions/{function_slug}',
        {
          params: {
            path: {
              ref: projectId,
              function_slug: functionSlug,
            },
          },
        }
      );

      if (functionResponse.error) {
        throw functionResponse.error;
      }

      assertSuccess(functionResponse, 'Failed to fetch Edge Function');

      const edgeFunction = functionResponse.data;

      const deploymentId = getDeploymentId(
        projectId,
        edgeFunction.id,
        edgeFunction.version
      );

      const entrypoint_path = edgeFunction.entrypoint_path
        ? normalizeFilename({
            deploymentId,
            filename: fileURLToPath(edgeFunction.entrypoint_path, {
              windows: false,
            }),
          })
        : undefined;

      const import_map_path = edgeFunction.import_map_path
        ? normalizeFilename({
            deploymentId,
            filename: fileURLToPath(edgeFunction.import_map_path, {
              windows: false,
            }),
          })
        : undefined;

      const bodyResponse = await managementApiClient.GET(
        '/v1/projects/{ref}/functions/{function_slug}/body',
        {
          params: {
            path: {
              ref: projectId,
              function_slug: functionSlug,
            },
          },
          headers: {
            Accept: 'multipart/form-data',
          },
          parseAs: 'stream',
        }
      );

      assertSuccess(bodyResponse, 'Failed to fetch Edge Function files');

      const contentType = bodyResponse.response.headers.get('content-type');

      if (!contentType || !contentType.startsWith('multipart/form-data')) {
        throw new Error(
          `Unexpected content type: ${contentType}. Expected multipart/form-data.`
        );
      }

      const boundary = getMultipartBoundary(contentType);

      if (!boundary) {
        throw new Error('No multipart boundary found in response headers');
      }

      if (!bodyResponse.data) {
        throw new Error('No data received from Edge Function body');
      }

      const files: EdgeFunctionWithBody['files'] = [];
      const parts = parseMultipartStream(bodyResponse.data, { boundary });

      for await (const part of parts) {
        if (part.isFile && part.filename) {
          files.push({
            name: normalizeFilename({
              deploymentId,
              filename: part.filename,
            }),
            content: part.text,
          });
        }
      }

      return {
        ...edgeFunction,
        entrypoint_path,
        import_map_path,
        files,
      };
    },
    async deployEdgeFunction(
      projectId: string,
      options: DeployEdgeFunctionOptions
    ) {
      let {
        name,
        entrypoint_path,
        import_map_path,
        verify_jwt,
        files: inputFiles,
      } = deployEdgeFunctionOptionsSchema.parse(options);

      let existingEdgeFunction: EdgeFunction | undefined;
      try {
        existingEdgeFunction = await functions.getEdgeFunction(projectId, name);
      } catch (error) {}

      const import_map_file = inputFiles.find((file) =>
        ['deno.json', 'import_map.json'].includes(file.name)
      );

      // Use existing import map path or file name heuristic if not provided
      import_map_path ??=
        existingEdgeFunction?.import_map_path ?? import_map_file?.name;

      const response = await managementApiClient.POST(
        '/v1/projects/{ref}/functions/deploy',
        {
          params: {
            path: {
              ref: projectId,
            },
            query: { slug: name },
          },
          body: {
            metadata: {
              name,
              entrypoint_path,
              import_map_path,
              verify_jwt,
            },
            file: inputFiles as any, // We need to pass file name and content to our serializer
          },
          bodySerializer(body) {
            const formData = new FormData();

            const blob = new Blob([JSON.stringify(body.metadata)], {
              type: 'application/json',
            });
            formData.append('metadata', blob);

            body.file?.forEach((f: any) => {
              const file: { name: string; content: string } = f;
              const blob = new Blob([file.content], {
                type: 'application/typescript',
              });
              formData.append('file', blob, file.name);
            });

            return formData;
          },
        }
      );

      assertSuccess(response, 'Failed to deploy Edge Function');

      return response.data;
    },
  };

  const branching: BranchingOperations = {
    async listBranches(projectId: string) {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/branches',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
        }
      );

      // There are no branches if branching is disabled
      if (response.response.status === 422) return [];
      assertSuccess(response, 'Failed to list branches');

      return response.data;
    },
    async createBranch(projectId: string, options: CreateBranchOptions) {
      const { name } = createBranchOptionsSchema.parse(options);

      const createBranchResponse = await managementApiClient.POST(
        '/v1/projects/{ref}/branches',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
          body: {
            branch_name: name,
          },
        }
      );

      assertSuccess(createBranchResponse, 'Failed to create branch');

      return createBranchResponse.data;
    },
    async deleteBranch(branchId: string) {
      const response = await managementApiClient.DELETE(
        '/v1/branches/{branch_id_or_ref}',
        {
          params: {
            path: {
              branch_id_or_ref: branchId,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to delete branch');
    },
    async mergeBranch(branchId: string) {
      const response = await managementApiClient.POST(
        '/v1/branches/{branch_id_or_ref}/merge',
        {
          params: {
            path: {
              branch_id_or_ref: branchId,
            },
          },
          body: {},
        }
      );

      assertSuccess(response, 'Failed to merge branch');
    },
    async resetBranch(branchId: string, options: ResetBranchOptions) {
      const { migration_version } = resetBranchOptionsSchema.parse(options);

      const response = await managementApiClient.POST(
        '/v1/branches/{branch_id_or_ref}/reset',
        {
          params: {
            path: {
              branch_id_or_ref: branchId,
            },
          },
          body: {
            migration_version,
          },
        }
      );

      assertSuccess(response, 'Failed to reset branch');
    },
    async rebaseBranch(branchId: string) {
      const response = await managementApiClient.POST(
        '/v1/branches/{branch_id_or_ref}/push',
        {
          params: {
            path: {
              branch_id_or_ref: branchId,
            },
          },
          body: {},
        }
      );

      assertSuccess(response, 'Failed to rebase branch');
    },
  };

  const storage: StorageOperations = {
    // Storage methods
    async listAllBuckets(project_id: string) {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/storage/buckets',
        {
          params: {
            path: {
              ref: project_id,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to list storage buckets');

      return response.data;
    },

    async getStorageConfig(project_id: string) {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/config/storage',
        {
          params: {
            path: {
              ref: project_id,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to get storage config');

      return response.data;
    },

    async updateStorageConfig(projectId: string, config: StorageConfig) {
      const response = await managementApiClient.PATCH(
        '/v1/projects/{ref}/config/storage',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
          body: {
            fileSizeLimit: config.fileSizeLimit,
            features: {
              imageTransformation: {
                enabled: config.features.imageTransformation.enabled,
              },
              s3Protocol: {
                enabled: config.features.s3Protocol.enabled,
              },
            },
          },
        }
      );

      assertSuccess(response, 'Failed to update storage config');
    },
  };

  const secrets: SecretOperations = {
    async getUpdatedAt(projectId: string, name: string) {
      const response = await managementApiClient.GET(
        '/v1/projects/{ref}/secrets',
        {
          params: {
            path: {
              ref: projectId,
            },
          },
        }
      );

      assertSuccess(response, 'Failed to fetch secrets');

      const secret = response.data.find((s) => s.name === name);
      if (!secret || !secret.updated_at) {
        return undefined;
      }

      return new Date(secret.updated_at);
    },
  };

  const platform: SupabasePlatform = {
    async init(info: InitData) {
      const { clientInfo } = info;
      if (!clientInfo) {
        throw new Error('Client info is required');
      }

      // Re-initialize the management API client with the user agent
      managementApiClient = createManagementApiClient(
        managementApiUrl,
        accessToken,
        {
          'User-Agent': `supabase-mcp/${version} (${clientInfo.name}/${clientInfo.version})`,
        }
      );
    },
    account,
    database,
    debugging,
    development,
    functions,
    branching,
    storage,
    secrets,
  };

  return platform;
}

function getProjectDomain(apiHostname: string) {
  switch (apiHostname) {
    case 'api.supabase.com':
      return 'supabase.co';
    case 'api.supabase.green':
      return 'supabase.green';
    default:
      return 'supabase.red';
  }
}
