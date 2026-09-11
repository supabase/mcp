import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { source } from 'common-tags';
import { format } from 'date-fns';
import { buildSchema, parse, validate } from 'graphql';
import { http, HttpResponse } from 'msw';
import { setupServer, type SetupServer } from 'msw/node';
import { customAlphabet } from 'nanoid';
import { join } from 'node:path/posix';
import { expect } from 'vitest';
import { z } from 'zod/v4';
import packageJson from '../package.json' with { type: 'json' };
import {
  getQueryFields,
  graphqlRequestSchema,
} from '../src/content-api/graphql.js';
import { getDeploymentId, getPathPrefix } from '../src/edge-function.js';
import type { components } from '../src/management-api/types.js';

const { version } = packageJson;

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz', 20);

export const API_URL = 'https://api.supabase.com';
export const CONTENT_API_URL = 'https://supabase.com/docs/api/graphql';
export const MCP_SERVER_NAME = 'supabase-mcp';
export const MCP_SERVER_VERSION = version;
export const MCP_CLIENT_NAME = 'test-client';
export const MCP_CLIENT_VERSION = '1.0.0';
export const ACCESS_TOKEN = 'dummy-token';
export const COUNTRY_CODE = 'US';
export const CLOSEST_REGION = 'us-east-2';

export const contentApiMockSchema = source`
  schema {
    query: RootQueryType
  }
    
  type RootQueryType {
    """Get the GraphQL schema for this endpoint"""
    schema: String!

    """Search the Supabase docs for content matching a query string"""
    searchDocs(query: String!, limit: Int): SearchResultCollection
  }

  """Document that matches a search query"""
  interface SearchResult {
    """The title of the matching result"""
    title: String

    """The URL of the matching result"""
    href: String

    """The full content of the matching result"""
    content: String
  }

  """A collection of search results containing content from Supabase docs"""
  type SearchResultCollection {
    """A list of edges containing nodes in this collection"""
    edges: [SearchResultEdge!]!

    """The nodes in this collection, directly accessible"""
    nodes: [SearchResult!]!
  }

  """An edge in a collection of SearchResults"""
  type SearchResultEdge {
    """The SearchResult at the end of the edge"""
    node: SearchResult!
  }
`;

type Organization = components['schemas']['V1OrganizationSlugResponse_Output'];
type Project = components['schemas']['V1ProjectWithDatabaseResponse_Output'];
type Branch = components['schemas']['BranchResponse_Output'];

export type Migration = {
  version: string;
  name: string;
  query: string;
};

export const mockOrgs = new Map<string, MockOrganization>();
export const mockProjects = new Map<string, MockProject>();
export const mockBranches = new Map<string, MockBranch>();
export const mockSecrets = new Map<
  string,
  Array<{ name: string; value: string; updated_at: string }>
>();

export const mockContentApiSchemaLoadCount = { value: 0 };

export const mockContentApi = [
  http.get(CONTENT_API_URL, async ({ request }) => {
    const requestUrl = new URL(request.url);
    const queryParam = requestUrl.searchParams.get('query') ?? '';
    const variablesParam = requestUrl.searchParams.get('variables');

    let variables: Record<string, unknown> | undefined;
    if (variablesParam) {
      try {
        variables = JSON.parse(variablesParam);
      } catch {
        throw Error('Invalid query made to Content API');
      }
    }

    const { query } = graphqlRequestSchema.parse({
      query: queryParam,
      variables,
    });

    const schema = buildSchema(contentApiMockSchema);
    const document = parse(query);
    const validationErrors = validate(schema, document);

    const [queryName] = getQueryFields(document);

    if (queryName === 'schema') {
      mockContentApiSchemaLoadCount.value++;
      return HttpResponse.json({
        data: {
          schema: contentApiMockSchema,
        },
      });
    }

    if (validationErrors.length > 0) {
      throw Error('Invalid query made to Content API');
    }

    return HttpResponse.json({
      data: {
        dummy: true,
      },
    });
  }),
];

export const mockManagementApi = [
  /**
   * Check authorization
   */
  http.all(`${API_URL}/*`, ({ request }) => {
    const authHeader = request.headers.get('Authorization');

    const accessToken = authHeader?.replace('Bearer ', '');
    if (accessToken !== ACCESS_TOKEN) {
      return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
  }),

  /**
   * Check user agent
   */
  http.all(`${API_URL}/*`, ({ request }) => {
    const userAgent = request.headers.get('user-agent');
    expect(userAgent).toBe(
      `${MCP_SERVER_NAME}/${MCP_SERVER_VERSION} (${MCP_CLIENT_NAME}/${MCP_CLIENT_VERSION})`
    );
  }),

  /**
   * List all projects
   */
  http.get(`${API_URL}/v1/projects`, () => {
    return HttpResponse.json(
      Array.from(mockProjects.values()).map((project) => project.details)
    );
  }),

  /**
   * Get details for a project
   */
  http.get<{ projectId: string }>(
    `${API_URL}/v1/projects/:projectId`,
    ({ params }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }
      return HttpResponse.json(project.details);
    }
  ),

  /**
   * Create a new project
   */
  http.post(`${API_URL}/v1/projects`, async ({ request }) => {
    const bodySchema = z.object({
      name: z.string(),
      region: z.string(),
      organization_slug: z.string(),
      db_pass: z.string(),
    });
    const body = await request.json();
    const { name, region, organization_slug } = bodySchema.parse(body);

    const project = await createProject({
      name,
      region,
      organization_id: organization_slug,
    });

    const { database, ...projectResponse } = project.details;

    return HttpResponse.json(projectResponse);
  }),

  /**
   * Pause a project
   */
  http.post<{ projectId: string }>(
    `${API_URL}/v1/projects/:projectId/pause`,
    ({ params }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { error: 'Project not found' },
          { status: 404 }
        );
      }
      project.status = 'INACTIVE';
      return HttpResponse.json(project.details);
    }
  ),

  /**
   * Restore a project
   */
  http.post<{ projectId: string }>(
    `${API_URL}/v1/projects/:projectId/restore`,
    ({ params }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { error: 'Project not found' },
          { status: 404 }
        );
      }
      project.status = 'ACTIVE_HEALTHY';
      return HttpResponse.json(project.details);
    }
  ),

  /**
   * List organizations
   */
  http.get(`${API_URL}/v1/organizations`, () => {
    return HttpResponse.json(
      Array.from(mockOrgs.values()).map(({ id, slug, name }) => ({
        id,
        slug,
        name,
      }))
    );
  }),

  /**
   * Get details for an organization
   */
  http.get(`${API_URL}/v1/organizations/:id`, ({ params }) => {
    const organization = Array.from(mockOrgs.values()).find(
      (org) => org.id === params.id
    );
    return HttpResponse.json(organization);
  }),

  /**
   * Get the API keys for a project
   */
  http.get(`${API_URL}/v1/projects/:projectId/api-keys`, ({ params }) => {
    return HttpResponse.json([
      {
        name: 'anon',
        api_key: 'dummy-anon-key',
        type: 'legacy',
        id: 'anon-key-id',
      },
      {
        name: 'publishable-key-1',
        api_key: 'sb_publishable_dummy_key_1',
        type: 'publishable',
        id: 'publishable-key-1-id',
        description: 'Main publishable key',
      },
    ]);
  }),

  /**
   * Check if legacy API keys are enabled
   */
  http.get(
    `${API_URL}/v1/projects/:projectId/api-keys/legacy`,
    ({ params }) => {
      return HttpResponse.json({ enabled: false });
    }
  ),

  /**
   * Execute a SQL query on a project's database
   */
  http.post<
    { projectId: string },
    { query: string; parameters?: unknown[]; read_only?: boolean }
  >(
    `${API_URL}/v1/projects/:projectId/database/query`,
    async ({ params, request }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }
      const { db } = project;
      const { query, parameters, read_only } = await request.json();

      try {
        // Use transaction to prevent race conditions if tests are parallelized
        const result = await db.transaction(async (tx) => {
          // Set role before executing query
          await tx.exec(
            `SET ROLE ${read_only ? 'supabase_read_only_role' : 'postgres'};`
          );

          // Use query() method with parameters if provided, otherwise use exec()
          const queryResult =
            parameters && parameters.length > 0
              ? await tx.query(query, parameters)
              : await tx.exec(query);

          // Reset role
          await tx.exec('RESET ROLE;');

          return queryResult;
        });

        // Handle different response formats
        if (Array.isArray(result)) {
          // exec() returns an array of results
          const lastStatementResults = result.at(-1);
          if (!lastStatementResults) {
            return HttpResponse.json(
              { message: 'Failed to execute query' },
              { status: 500 }
            );
          }
          return HttpResponse.json(lastStatementResults.rows);
        } else {
          // query() returns a single result object
          return HttpResponse.json(result.rows);
        }
      } catch (error) {
        throw error;
      }
    }
  ),

  /**
   * Lists all Edge Functions for a project
   */
  http.get<{ projectId: string }>(
    `${API_URL}/v1/projects/:projectId/functions`,
    ({ params }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      return HttpResponse.json(
        Array.from(project.edge_functions.values()).map(
          (edgeFunction) => edgeFunction.details
        )
      );
    }
  ),

  /**
   * Get details for an Edge Function
   */
  http.get<{ projectId: string; functionSlug: string }>(
    `${API_URL}/v1/projects/:projectId/functions/:functionSlug`,
    ({ params }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      const edgeFunction = project.edge_functions.get(params.functionSlug);

      if (!edgeFunction) {
        return HttpResponse.json(
          { message: 'Edge Function not found' },
          { status: 404 }
        );
      }

      return HttpResponse.json(edgeFunction.details);
    }
  ),

  /**
   * Gets the files for an Edge Function
   */
  http.get<{ projectId: string; functionSlug: string }>(
    `${API_URL}/v1/projects/:projectId/functions/:functionSlug/body`,
    ({ params, request }) => {
      if (request.headers.get('Accept') !== 'multipart/form-data') {
        return HttpResponse.json(
          {
            message:
              'Invalid Accept header. Must be multipart/form-data for testing',
          },
          { status: 406 }
        );
      }

      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      const edgeFunction = project.edge_functions.get(params.functionSlug);
      if (!edgeFunction) {
        return HttpResponse.json(
          { message: 'Edge Function not found' },
          { status: 404 }
        );
      }

      const formData = new FormData();
      for (const file of edgeFunction.files) {
        formData.append('file', file, file.name);
      }

      return HttpResponse.formData(formData);
    }
  ),

  /**
   * Deploys an Edge Function
   */
  http.post<{ projectId: string }>(
    `${API_URL}/v1/projects/:projectId/functions/deploy`,
    async ({ params, request }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }
      const formData = await request.formData();

      const metadataSchema = z.object({
        name: z.string(),
        entrypoint_path: z.string(),
        import_map_path: z.string().optional(),
        verify_jwt: z.boolean().optional(),
      });

      const metadataFormValue = formData.get('metadata');
      const metadataString =
        metadataFormValue instanceof File
          ? await metadataFormValue.text()
          : (metadataFormValue ?? undefined);

      if (!metadataString) {
        throw new Error('Metadata is required');
      }

      const metadata = metadataSchema.parse(JSON.parse(metadataString));

      const fileFormValues = formData.getAll('file');

      const files = fileFormValues.map((file) => {
        if (typeof file === 'string') {
          throw new Error('Multipart file is a string instead of a File');
        }
        return file;
      });

      const edgeFunction = await project.deployEdgeFunction(metadata, files);

      return HttpResponse.json(edgeFunction.details);
    }
  ),

  /**
   * List migrations for a project
   */
  http.get<{ projectId: string }>(
    `${API_URL}/v1/projects/:projectId/database/migrations`,
    async ({ params }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      const { migrations } = project;
      const modified = migrations.map(({ version, name }) => ({
        version,
        name,
      }));

      return HttpResponse.json(modified);
    }
  ),

  /**
   * Create a new migration for a project
   */
  http.post<{ projectId: string }, { name: string; query: string }>(
    `${API_URL}/v1/projects/:projectId/database/migrations`,
    async ({ params, request }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }
      const { db, migrations } = project;
      const { name, query } = await request.json();
      const [results] = await db.exec(query);

      if (!results) {
        return HttpResponse.json(
          { message: 'Failed to execute query' },
          { status: 500 }
        );
      }

      migrations.push({
        version: format(new Date(), 'yyyyMMddHHmmss'),
        name,
        query,
      });

      return HttpResponse.json(results.rows);
    }
  ),

  /**
   * Get logs for a project
   */
  http.get<{ projectId: string }, { sql: string }>(
    `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
    async ({ params }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      return HttpResponse.json([]);
    }
  ),

  /**
   * Get security advisors for a project
   */
  http.get<{ projectId: string }, { sql: string }>(
    `${API_URL}/v1/projects/:projectId/advisors/security`,
    async ({ params }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      return HttpResponse.json({
        lints: [],
      });
    }
  ),

  /**
   * Get performance advisors for a project
   */
  http.get<{ projectId: string }, { sql: string }>(
    `${API_URL}/v1/projects/:projectId/advisors/performance`,
    async ({ params }) => {
      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      return HttpResponse.json({
        lints: [],
      });
    }
  ),

  /**
   * Create a new branch for a project
   */
  http.post<{ projectId: string }, { branch_name: string }>(
    `${API_URL}/v1/projects/:projectId/branches`,
    async ({ params, request }) => {
      const { branch_name } = await request.json();

      const project = mockProjects.get(params.projectId);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      const projectBranches = Array.from(mockBranches.values()).filter(
        (branch) => branch.parent_project_ref === project.id
      );

      if (projectBranches.length === 0) {
        // If this is the first branch, set it as the default branch pointing to the same project
        const defaultBranch = new MockBranch({
          name: branch_name,
          project_ref: project.id,
          parent_project_ref: project.id,
          is_default: true,
        });
        defaultBranch.status = 'MIGRATIONS_PASSED';
        mockBranches.set(defaultBranch.id, defaultBranch);
      }

      const branch = await createBranch({
        name: branch_name,
        parent_project_ref: project.id,
      });

      return HttpResponse.json(branch.details);
    }
  ),

  /**
   * List all branches for a project
   */
  http.get<{ projectId: string }>(
    `${API_URL}/v1/projects/:projectId/branches`,
    async ({ params }) => {
      const projectBranches = Array.from(mockBranches.values()).filter(
        (branch) => branch.parent_project_ref === params.projectId
      );

      if (projectBranches.length === 0) {
        return HttpResponse.json(
          { message: 'Preview branching is not enabled for this project.' },
          { status: 422 }
        );
      }

      return HttpResponse.json(projectBranches.map((branch) => branch.details));
    }
  ),

  /**
   * Get details for a branch
   */
  http.delete<{ branchId: string }>(
    `${API_URL}/v1/branches/:branchId`,
    async ({ params }) => {
      const branch = mockBranches.get(params.branchId);

      if (!branch) {
        return HttpResponse.json(
          { message: 'Branch not found' },
          { status: 404 }
        );
      }

      // if default branch, return error
      if (branch.is_default) {
        return HttpResponse.json(
          { message: 'Cannot delete the default branch.' },
          { status: 422 }
        );
      }

      const project = mockProjects.get(branch.project_ref);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      await project.destroy();
      mockProjects.delete(project.id);
      mockBranches.delete(branch.id);

      return HttpResponse.json({ message: 'ok' });
    }
  ),

  /**
   * Merges migrations from a development branch to production
   */
  http.post<{ branchId: string }>(
    `${API_URL}/v1/branches/:branchId/merge`,
    async ({ params }) => {
      const branch = mockBranches.get(params.branchId);
      if (!branch) {
        return HttpResponse.json(
          { message: 'Branch not found' },
          { status: 404 }
        );
      }

      const parentProject = mockProjects.get(branch.parent_project_ref);
      if (!parentProject) {
        return HttpResponse.json(
          { message: 'Parent project not found' },
          { status: 404 }
        );
      }

      const project = mockProjects.get(branch.project_ref);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      // Simulate merge by resetting the parent DB and running branch migrations
      parentProject.migrations = [...project.migrations];
      await parentProject.resetDb();
      try {
        await parentProject.applyMigrations();
      } catch (error) {
        return HttpResponse.json(
          { message: 'Failed to apply migrations' },
          { status: 500 }
        );
      }

      return HttpResponse.json({ message: 'ok' });
    }
  ),

  /**
   * Resets a branch and re-runs migrations
   */
  http.post<{ branchId: string }, { migration_version?: string }>(
    `${API_URL}/v1/branches/:branchId/reset`,
    async ({ params, request }) => {
      const branch = mockBranches.get(params.branchId);
      if (!branch) {
        return HttpResponse.json(
          { message: 'Branch not found' },
          { status: 404 }
        );
      }

      const project = mockProjects.get(branch.project_ref);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      // Clear migrations below the specified version
      const body = await request.json();
      if (body.migration_version) {
        const target = body.migration_version;
        project.migrations = project.migrations.filter(
          (m) => m.version <= target
        );
      }

      // Reset the DB a re-run migrations
      await project.resetDb();
      try {
        await project.applyMigrations();
        branch.status = 'MIGRATIONS_PASSED';
      } catch (error) {
        branch.status = 'MIGRATIONS_FAILED';
        return HttpResponse.json(
          { message: 'Failed to apply migrations' },
          { status: 500 }
        );
      }

      return HttpResponse.json({ message: 'ok' });
    }
  ),

  /**
   * Rebase migrations from production on a development branch
   */
  http.post<{ branchId: string }>(
    `${API_URL}/v1/branches/:branchId/push`,
    async ({ params }) => {
      const branch = mockBranches.get(params.branchId);
      if (!branch) {
        return HttpResponse.json(
          { message: 'Branch not found' },
          { status: 404 }
        );
      }

      const parentProject = mockProjects.get(branch.parent_project_ref);
      if (!parentProject) {
        return HttpResponse.json(
          { message: 'Parent project not found' },
          { status: 404 }
        );
      }

      const project = mockProjects.get(branch.project_ref);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      // Simulate rebase by resetting the branch DB and running production migrations
      project.migrations = [...parentProject.migrations];
      await project.resetDb();
      try {
        await project.applyMigrations();
        branch.status = 'MIGRATIONS_PASSED';
      } catch (error) {
        branch.status = 'MIGRATIONS_FAILED';
        return HttpResponse.json(
          { message: 'Failed to apply migrations' },
          { status: 500 }
        );
      }

      return HttpResponse.json({ message: 'ok' });
    }
  ),

  /**
   * List secrets
   */
  http.get<{ projectId: string }>(
    `${API_URL}/v1/projects/:projectId/secrets`,
    ({ params }) => {
      const secrets = mockSecrets.get(params.projectId) ?? [];
      return HttpResponse.json(secrets);
    }
  ),

  /**
   * List storage buckets
   */
  http.get<{ ref: string }>(
    `${API_URL}/v1/projects/:ref/storage/buckets`,
    ({ params }) => {
      const project = mockProjects.get(params.ref);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      const buckets = Array.from(project.storage_buckets.values()).map(
        (bucket) => ({
          id: bucket.id,
          name: bucket.name,
          public: bucket.public,
          created_at: bucket.created_at.toISOString(),
          updated_at: bucket.updated_at.toISOString(),
        })
      );

      return HttpResponse.json(buckets);
    }
  ),

  /**
   * Get storage config
   */
  http.get<{ ref: string }>(
    `${API_URL}/v1/projects/:ref/config/storage`,
    ({ params }) => {
      const project = mockProjects.get(params.ref);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      return HttpResponse.json({
        fileSizeLimit: 50,
        features: {
          imageTransformation: { enabled: true },
          s3Protocol: { enabled: false },
        },
      });
    }
  ),

  /**
   * Update storage config
   */
  http.patch<{ ref: string }>(
    `${API_URL}/v1/projects/:ref/config/storage`,
    async ({ params, request }) => {
      const project = mockProjects.get(params.ref);
      if (!project) {
        return HttpResponse.json(
          { message: 'Project not found' },
          { status: 404 }
        );
      }

      // Accept any valid config
      try {
        await request.json();
        return new HttpResponse(null, { status: 204 });
      } catch (e) {
        return HttpResponse.json(
          { message: 'Invalid request body' },
          { status: 400 }
        );
      }
    }
  ),
];

export function setupMockApis(): SetupServer {
  mockOrgs.clear();
  mockProjects.clear();
  mockBranches.clear();
  mockSecrets.clear();
  mockContentApiSchemaLoadCount.value = 0;

  const mockServer = setupServer(...mockContentApi, ...mockManagementApi);
  mockServer.listen({ onUnhandledRequest: 'error' });

  return mockServer;
}

export async function createOrganization(options: MockOrganizationOptions) {
  const org = new MockOrganization(options);
  mockOrgs.set(org.id, org);
  return org;
}

export async function createProject(options: MockProjectOptions) {
  const project = new MockProject(options);

  mockProjects.set(project.id, project);

  // Change the project status to ACTIVE_HEALTHY after a delay
  setTimeout(async () => {
    project.status = 'ACTIVE_HEALTHY';
  }, 0);

  return project;
}

export async function createBranch(options: {
  name: string;
  parent_project_ref: string;
}) {
  const parentProject = mockProjects.get(options.parent_project_ref);
  if (!parentProject) {
    throw new Error(`Project with id ${options.parent_project_ref} not found`);
  }

  const project = new MockProject({
    name: `${parentProject.name} - ${options.name}`,
    region: parentProject.region,
    organization_id: parentProject.organization_id,
  });

  const branch = new MockBranch({
    name: options.name,
    project_ref: project.id,
    parent_project_ref: options.parent_project_ref,
    is_default: false,
  });

  mockProjects.set(project.id, project);
  mockBranches.set(branch.id, branch);

  project.migrations = [...parentProject.migrations];

  // Run migrations on the new branch in the background
  setTimeout(async () => {
    try {
      await project.applyMigrations();
      branch.status = 'MIGRATIONS_PASSED';
    } catch (error) {
      branch.status = 'MIGRATIONS_FAILED';
      console.error('Migration error:', error);
    }
  }, 0);

  return branch;
}

export type MockOrganizationOptions = {
  name: Organization['name'];
  plan: Organization['plan'];
  allowed_release_channels: Organization['allowed_release_channels'];
  opt_in_tags?: Organization['opt_in_tags'];
};

export class MockOrganization {
  id: string;
  slug: string;
  name: Organization['name'];
  plan: Organization['plan'];
  allowed_release_channels: Organization['allowed_release_channels'];
  opt_in_tags: Organization['opt_in_tags'];

  get details(): Organization {
    return {
      id: this.id,
      name: this.name,
      plan: this.plan,
      allowed_release_channels: this.allowed_release_channels,
      opt_in_tags: this.opt_in_tags,
    };
  }

  constructor(options: MockOrganizationOptions) {
    this.id = nanoid();
    this.slug = nanoid();
    this.name = options.name;
    this.plan = options.plan;
    this.allowed_release_channels = options.allowed_release_channels;
    this.opt_in_tags = options.opt_in_tags ?? [];
  }
}

export type MockEdgeFunctionOptions = {
  name: string;
  entrypoint_path: string;
  import_map_path?: string;
  verify_jwt?: boolean;
};

export class MockEdgeFunction {
  projectId: string;
  id: string;
  slug: string;
  version: number;
  name: string;
  status: 'ACTIVE' | 'REMOVED' | 'THROTTLED';
  entrypoint_path: string;
  import_map_path?: string;
  import_map: boolean;
  verify_jwt: boolean;
  created_at: Date;
  updated_at: Date;

  files: File[] = [];

  async setFiles(files: File[]) {
    this.files = [];
    for (const file of files) {
      this.files.push(
        new File([file], `${join(this.pathPrefix, file.name)}`, {
          type: file.type,
        })
      );
    }
  }

  get deploymentId() {
    return getDeploymentId(this.projectId, this.id, this.version);
  }

  get pathPrefix() {
    return getPathPrefix(this.deploymentId);
  }

  get details() {
    return {
      id: this.id,
      slug: this.slug,
      version: this.version,
      name: this.name,
      status: this.status,
      entrypoint_path: this.entrypoint_path,
      import_map_path: this.import_map_path,
      import_map: this.import_map,
      verify_jwt: this.verify_jwt,
      created_at: this.created_at.getTime(),
      updated_at: this.updated_at.getTime(),
    };
  }

  constructor(
    projectId: string,
    {
      name,
      entrypoint_path,
      import_map_path,
      verify_jwt,
    }: MockEdgeFunctionOptions
  ) {
    this.projectId = projectId;
    this.id = crypto.randomUUID();
    this.slug = name;
    this.version = 1;
    this.name = name;
    this.status = 'ACTIVE';
    this.entrypoint_path = `file://${join(this.pathPrefix, entrypoint_path)}`;
    this.import_map_path = import_map_path
      ? `file://${join(this.pathPrefix, import_map_path)}`
      : undefined;
    this.import_map = !!import_map_path;
    this.verify_jwt = verify_jwt ?? true;
    this.created_at = new Date();
    this.updated_at = new Date();
  }

  update({
    name,
    entrypoint_path,
    import_map_path,
    verify_jwt,
  }: MockEdgeFunctionOptions) {
    this.name = name;
    this.version += 1;
    this.entrypoint_path = `file://${join(this.pathPrefix, entrypoint_path)}`;
    this.import_map_path = import_map_path
      ? `file://${join(this.pathPrefix, import_map_path)}`
      : undefined;
    this.import_map = !!import_map_path;
    if (verify_jwt !== undefined) {
      this.verify_jwt = verify_jwt;
    }
    this.updated_at = new Date();
  }
}

export type MockStorageBucketOptions = {
  name: string;
  isPublic: boolean;
};

export class MockStorageBucket {
  id: string;
  name: string;
  public: boolean;
  created_at: Date;
  updated_at: Date;

  constructor({ name, isPublic }: MockStorageBucketOptions) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.public = isPublic;
    this.created_at = new Date();
    this.updated_at = new Date();
  }
}

export type MockProjectOptions = {
  name: string;
  region: string;
  organization_id: string;
};

export class MockProject {
  id: string;
  ref: string;
  organization_id: string;
  organization_slug: string;
  name: string;
  region: string;
  created_at: Date;
  status: Project['status'];
  database: {
    host: string;
    version: string;
    postgres_engine: string;
    release_channel: string;
  };

  migrations: Migration[] = [];
  edge_functions = new Map<string, MockEdgeFunction>();
  storage_buckets = new Map<string, MockStorageBucket>();

  #db?: PGliteInterface;

  // Lazy load the database connection
  get db() {
    if (!this.#db) {
      this.#db = new PGlite();
      this.#db.waitReady.then(() => {
        this.#db!.exec(`
          CREATE ROLE supabase_read_only_role;
          GRANT pg_read_all_data TO supabase_read_only_role;
        `);
      });
    }
    return this.#db;
  }

  get details(): Project {
    return {
      id: this.id,
      ref: this.ref,
      organization_id: this.organization_id,
      organization_slug: this.organization_slug,
      name: this.name,
      region: this.region,
      created_at: this.created_at.toISOString(),
      status: this.status,
      database: this.database,
    };
  }

  constructor({ name, region, organization_id }: MockProjectOptions) {
    this.id = nanoid();
    this.ref = this.id;

    this.name = name;
    this.region = region;
    this.organization_id = organization_id;
    this.organization_slug = organization_id;

    this.created_at = new Date();
    this.status = 'UNKNOWN';
    this.database = {
      host: `db.${this.id}.supabase.co`,
      version: '15.1',
      postgres_engine: '15',
      release_channel: 'ga',
    };
  }

  async applyMigrations() {
    for (const migration of this.migrations) {
      const [results] = await this.db.exec(migration.query);
      if (!results) {
        throw new Error(`Failed to execute migration ${migration.name}`);
      }
    }
  }

  async resetDb() {
    if (this.#db) {
      await this.#db.close();
    }
    this.#db = undefined;
    return this.db;
  }

  async deployEdgeFunction(
    options: MockEdgeFunctionOptions,
    files: File[] = []
  ) {
    const edgeFunction = new MockEdgeFunction(this.id, options);
    const existingFunction = this.edge_functions.get(edgeFunction.slug);

    if (existingFunction) {
      existingFunction.update(options);
      await existingFunction.setFiles(files);
      return existingFunction;
    }

    await edgeFunction.setFiles(files);
    this.edge_functions.set(edgeFunction.slug, edgeFunction);

    return edgeFunction;
  }

  async destroy() {
    if (this.#db) {
      await this.#db.close();
    }
  }

  createStorageBucket(
    name: string,
    isPublic: boolean = false
  ): MockStorageBucket {
    const id = nanoid();
    const bucket: MockStorageBucket = {
      id,
      name,
      public: isPublic,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.storage_buckets.set(id, bucket);
    return bucket;
  }
}

export type MockBranchOptions = {
  name: string;
  project_ref: string;
  parent_project_ref: string;
  is_default: boolean;
};

export class MockBranch {
  id: string;
  name: string;
  project_ref: string;
  parent_project_ref: string;
  is_default: boolean;
  persistent: boolean;
  status: Branch['status'];
  created_at: Date;
  updated_at: Date;

  get details(): Branch {
    return {
      id: this.id,
      name: this.name,
      project_ref: this.project_ref,
      parent_project_ref: this.parent_project_ref,
      is_default: this.is_default,
      persistent: this.persistent,
      with_data: false,
      status: this.status,
      created_at: this.created_at.toISOString(),
      updated_at: this.updated_at.toISOString(),
    };
  }

  constructor({
    name,
    project_ref,
    parent_project_ref,
    is_default,
  }: MockBranchOptions) {
    this.id = nanoid();
    this.name = name;
    this.project_ref = project_ref;
    this.parent_project_ref = parent_project_ref;
    this.is_default = is_default;
    this.persistent = false;
    this.status = 'CREATING_PROJECT';
    this.created_at = new Date();
    this.updated_at = new Date();
  }
}
