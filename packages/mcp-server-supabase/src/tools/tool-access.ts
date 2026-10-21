import { CURRENT_FEATURE_GROUPS, type FeatureGroup } from '../types.js';
import { supabaseMcpToolSchemas } from './tool-schemas.js';

export type OAuthScopeHintSource = 'documented' | 'inferred';

export type OAuthScopeResource =
  | 'organizations'
  | 'projects'
  | 'database'
  | 'edge_functions'
  | 'environment'
  | 'secrets'
  | 'analytics'
  | 'advisors'
  | 'storage';

export type OAuthScopeLevel = 'read' | 'write';

export type OAuthScopeHint = {
  resource: OAuthScopeResource;
  level: OAuthScopeLevel;
  source: OAuthScopeHintSource;
};

export type ToolAccessEntry = {
  featureGroup: FeatureGroup;
  /**
   * Best-effort minimum requirements for the tool in normal mode.
   *
   * For documented Management API scope families, `source` is `documented`.
   * For MCP surfaces whose scope family is not currently listed in the public
   * OAuth docs, `source` is `inferred` from the Management API endpoint family.
   */
  requirements: readonly OAuthScopeHint[];
  /**
   * Optional override for tools that remain available in read-only mode but
   * adapt their behavior to a less privileged access pattern.
   */
  readOnlyRequirements?: readonly OAuthScopeHint[];
};

type ToolName = keyof typeof supabaseMcpToolSchemas;

const documented = (
  resource: Exclude<OAuthScopeResource, 'analytics' | 'advisors' | 'storage'>,
  level: OAuthScopeLevel
): OAuthScopeHint => ({
  resource,
  level,
  source: 'documented',
});

const inferred = (
  resource: Extract<OAuthScopeResource, 'analytics' | 'advisors' | 'storage'>,
  level: OAuthScopeLevel
): OAuthScopeHint => ({
  resource,
  level,
  source: 'inferred',
});

export const supabaseMcpToolAccessHints = {
  search_docs: {
    featureGroup: 'docs',
    requirements: [],
  },
  list_organizations: {
    featureGroup: 'account',
    requirements: [documented('organizations', 'read')],
  },
  get_organization: {
    featureGroup: 'account',
    requirements: [documented('organizations', 'read')],
  },
  list_projects: {
    featureGroup: 'account',
    requirements: [documented('projects', 'read')],
  },
  get_project: {
    featureGroup: 'account',
    requirements: [documented('projects', 'read')],
  },
  get_cost: {
    featureGroup: 'account',
    requirements: [
      documented('organizations', 'read'),
      documented('projects', 'read'),
    ],
  },
  confirm_cost: {
    featureGroup: 'account',
    requirements: [],
  },
  create_project: {
    featureGroup: 'account',
    requirements: [
      documented('organizations', 'read'),
      documented('projects', 'read'),
      documented('projects', 'write'),
    ],
  },
  pause_project: {
    featureGroup: 'account',
    requirements: [documented('projects', 'write')],
  },
  restore_project: {
    featureGroup: 'account',
    requirements: [documented('projects', 'write')],
  },
  list_tables: {
    featureGroup: 'database',
    requirements: [documented('database', 'read')],
  },
  list_extensions: {
    featureGroup: 'database',
    requirements: [documented('database', 'read')],
  },
  list_migrations: {
    featureGroup: 'database',
    requirements: [documented('database', 'read')],
  },
  apply_migration: {
    featureGroup: 'database',
    requirements: [documented('database', 'write')],
  },
  execute_sql: {
    featureGroup: 'database',
    requirements: [documented('database', 'write')],
    readOnlyRequirements: [documented('database', 'read')],
  },
  get_logs: {
    featureGroup: 'debugging',
    requirements: [inferred('analytics', 'read')],
  },
  get_advisors: {
    featureGroup: 'debugging',
    requirements: [inferred('advisors', 'read')],
  },
  get_project_url: {
    featureGroup: 'development',
    requirements: [],
  },
  get_publishable_keys: {
    featureGroup: 'development',
    requirements: [documented('secrets', 'read')],
  },
  generate_typescript_types: {
    featureGroup: 'development',
    requirements: [documented('database', 'read')],
  },
  list_edge_functions: {
    featureGroup: 'functions',
    requirements: [documented('edge_functions', 'read')],
  },
  get_edge_function: {
    featureGroup: 'functions',
    requirements: [documented('edge_functions', 'read')],
  },
  deploy_edge_function: {
    featureGroup: 'functions',
    requirements: [documented('edge_functions', 'write')],
  },
  create_branch: {
    featureGroup: 'branching',
    requirements: [documented('environment', 'write')],
  },
  list_branches: {
    featureGroup: 'branching',
    requirements: [documented('environment', 'read')],
  },
  delete_branch: {
    featureGroup: 'branching',
    requirements: [documented('environment', 'write')],
  },
  merge_branch: {
    featureGroup: 'branching',
    requirements: [documented('environment', 'write')],
  },
  reset_branch: {
    featureGroup: 'branching',
    requirements: [documented('environment', 'write')],
  },
  rebase_branch: {
    featureGroup: 'branching',
    requirements: [documented('environment', 'write')],
  },
  list_storage_buckets: {
    featureGroup: 'storage',
    requirements: [inferred('storage', 'read')],
  },
  get_storage_config: {
    featureGroup: 'storage',
    requirements: [inferred('storage', 'read')],
  },
  update_storage_config: {
    featureGroup: 'storage',
    requirements: [inferred('storage', 'write')],
  },
} as const satisfies Record<ToolName, ToolAccessEntry>;

const writeToolSet = new Set(
  Object.entries(supabaseMcpToolSchemas)
    .filter(
      ([, entry]) =>
        entry.annotations.readOnlyHint === false &&
        entry.readOnlyBehavior !== 'adapt'
    )
    .map(([name]) => name)
);

export type CreateToolAccessHintsOptions = {
  features?: readonly FeatureGroup[];
  projectScoped?: boolean;
  readOnly?: boolean;
};

export function createToolAccessHints(options: CreateToolAccessHintsOptions = {}) {
  const enabledFeatures = new Set(options.features ?? CURRENT_FEATURE_GROUPS);
  const projectScoped = options.projectScoped ?? false;
  const readOnly = options.readOnly ?? false;

  const result: Partial<Record<ToolName, ToolAccessEntry>> = {};

  for (const [toolName, entry] of Object.entries(supabaseMcpToolAccessHints) as [
    ToolName,
    ToolAccessEntry,
  ][]) {
    if (!enabledFeatures.has(entry.featureGroup)) continue;
    if (projectScoped && entry.featureGroup === 'account') continue;
    if (readOnly && writeToolSet.has(toolName)) continue;

    result[toolName] = entry;
  }

  return result;
}

function toScopeString({ resource, level }: OAuthScopeHint) {
  return `${resource}:${level}`;
}

export function createOAuthScopeHints(
  options: CreateToolAccessHintsOptions & {
    includeInferred?: boolean;
  } = {}
) {
  const includeInferred = options.includeInferred ?? false;
  const toolHints = createToolAccessHints(options);

  const scopes = new Map<string, OAuthScopeHint>();

  for (const entry of Object.values(toolHints)) {
    const requirements =
      options.readOnly && entry.readOnlyRequirements
        ? entry.readOnlyRequirements
        : entry.requirements;

    for (const requirement of requirements) {
      if (!includeInferred && requirement.source === 'inferred') continue;
      scopes.set(toScopeString(requirement), requirement);
    }
  }

  return [...scopes.values()]
    .sort((left, right) =>
      toScopeString(left).localeCompare(toScopeString(right))
    )
    .map(toScopeString);
}
