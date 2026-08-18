import type { z } from 'zod/v4';
import { CURRENT_FEATURE_GROUPS, type FeatureGroup } from '../types.js';
import { accountToolDefs } from './account-tools.js';
import { branchingToolDefs } from './branching-tools.js';
import { databaseToolDefs } from './database-operation-tools.js';
import { debuggingToolDefs } from './debugging-tools.js';
import { developmentToolDefs } from './development-tools.js';
import { docsToolDefs } from './docs-tools.js';
import { edgeFunctionToolDefs } from './edge-function-tools.js';
import { storageToolDefs } from './storage-tools.js';
import type { ToolDefs } from './util.js';

type DefsToSchemas<T extends ToolDefs> = {
  [K in keyof T]: {
    inputSchema: T[K]['parameters'];
    outputSchema: T[K]['outputSchema'];
    annotations: T[K]['annotations'];
    readOnlyBehavior: T[K] extends {
      readOnlyBehavior: infer R extends 'exclude' | 'adapt';
    }
      ? R
      : undefined;
    hidden: T[K] extends { hidden: infer H extends boolean } ? H : undefined;
  };
};

/** Exported for testing */
export function defsToSchemas<const T extends ToolDefs>(
  defs: T
): DefsToSchemas<T> {
  return Object.fromEntries(
    Object.entries(defs).map(
      ([name, { parameters: inputSchema, description: _, ...rest }]) => [
        name,
        { inputSchema, ...rest },
      ]
    )
  ) as DefsToSchemas<T>;
}

type SchemaEntry = {
  inputSchema: z.ZodObject<any>;
  outputSchema: z.ZodObject<any>;
  annotations: ToolDefs[string]['annotations'];
  readOnlyBehavior?: 'exclude' | 'adapt';
  /** If true, the tool is excluded from `tools/list` but kept in this registry for typed access. */
  hidden?: boolean;
};

/**
 * All Supabase MCP tool schemas (input + output pairs).
 *
 * Pass to AI SDK's `mcpClient.tools()` `schemas` option to get typed tool
 * inputs and outputs:
 * https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools#typed-tool-outputs
 *
 * @example
 * ```typescript
 * import { supabaseMcpToolSchemas } from '@supabase/mcp-server-supabase';
 *
 * const tools = await mcpClient.tools({
 *   schemas: supabaseMcpToolSchemas,
 * });
 * ```
 */
export const supabaseMcpToolSchemas = {
  ...defsToSchemas(accountToolDefs),
  ...defsToSchemas(branchingToolDefs),
  ...defsToSchemas(databaseToolDefs),
  ...defsToSchemas(debuggingToolDefs),
  ...defsToSchemas(developmentToolDefs),
  ...defsToSchemas(docsToolDefs),
  ...defsToSchemas(edgeFunctionToolDefs),
  ...defsToSchemas(storageToolDefs),
} satisfies Record<string, SchemaEntry>;

/**
 * Maps each feature group to its tool names.
 * Derived from the per-file tool defs so that adding a tool to a file
 * automatically includes it in the feature group.
 *
 * Used by {@link createToolSchemas} to filter tools by feature.
 */
const FEATURE_TOOL_MAP = {
  docs: Object.keys(docsToolDefs) as readonly (keyof typeof docsToolDefs)[],
  account: Object.keys(
    accountToolDefs
  ) as readonly (keyof typeof accountToolDefs)[],
  database: Object.keys(
    databaseToolDefs
  ) as readonly (keyof typeof databaseToolDefs)[],
  debugging: Object.keys(
    debuggingToolDefs
  ) as readonly (keyof typeof debuggingToolDefs)[],
  development: Object.keys(
    developmentToolDefs
  ) as readonly (keyof typeof developmentToolDefs)[],
  functions: Object.keys(
    edgeFunctionToolDefs
  ) as readonly (keyof typeof edgeFunctionToolDefs)[],
  branching: Object.keys(
    branchingToolDefs
  ) as readonly (keyof typeof branchingToolDefs)[],
  storage: Object.keys(
    storageToolDefs
  ) as readonly (keyof typeof storageToolDefs)[],
} satisfies Record<
  FeatureGroup,
  readonly (keyof typeof supabaseMcpToolSchemas)[]
>;

/**
 * Schemas with `project_id` omitted from input schemas.
 * Computed dynamically: any tool whose inputSchema has a `project_id`
 * key gets an override with that key omitted.
 *
 * Account tools also appear here but are excluded entirely in
 * project-scoped mode (matching server behavior).
 *
 * Used by {@link createToolSchemas} when `projectScoped` is true.
 */
const PROJECT_SCOPED_OVERRIDES: Record<string, SchemaEntry> =
  Object.fromEntries(
    Object.entries(supabaseMcpToolSchemas)
      .filter(([, { inputSchema }]) => 'project_id' in inputSchema.shape)
      .map(([name, { inputSchema, ...rest }]) => [
        name,
        {
          inputSchema: (inputSchema as z.ZodObject<any>).omit({
            project_id: true,
          }),
          ...rest,
        },
      ])
  );

/**
 * Cost tools that stay available in project-scoped mode when the
 * branching feature is enabled, since `create_branch` requires a cost
 * confirmation ID that can only be obtained from them.
 * Matches server behavior in `server.ts`.
 */
const PROJECT_SCOPED_COST_TOOLS = ['get_cost', 'confirm_cost'] as const;

type ProjectScopedCostToolName = (typeof PROJECT_SCOPED_COST_TOOLS)[number];

/**
 * Tools excluded entirely in read-only mode.
 * Derived from tool defs: any tool with `readOnlyHint: false` and no
 * `readOnlyBehavior: 'adapt'` annotation.
 */
export const writeToolSet = new Set(
  Object.entries(supabaseMcpToolSchemas)
    .filter(
      ([, entry]) =>
        entry.annotations.readOnlyHint === false &&
        entry.readOnlyBehavior !== 'adapt'
    )
    .map(([name]) => name)
);

type AllSchemas = typeof supabaseMcpToolSchemas;

/** Tool names whose inputSchema contains `project_id`. */
type ProjectScopedToolName = {
  [K in keyof AllSchemas]: 'project_id' extends keyof z.infer<
    AllSchemas[K]['inputSchema']
  >
    ? K
    : never;
}[keyof AllSchemas];

type ProjectScopedSchemas = {
  [K in ProjectScopedToolName]: {
    inputSchema: AllSchemas[K]['inputSchema'] extends z.ZodObject<infer S>
      ? z.ZodObject<Omit<S, 'project_id'>>
      : never;
    outputSchema: AllSchemas[K]['outputSchema'];
    annotations: AllSchemas[K]['annotations'];
  };
};

type ToolNameForFeature<Feature extends FeatureGroup> =
  (typeof FEATURE_TOOL_MAP)[Feature][number];

type AccountToolName = ToolNameForFeature<'account'>;
type WriteToolName = {
  [K in keyof AllSchemas]: AllSchemas[K]['annotations'] extends {
    readOnlyHint: false;
  }
    ? AllSchemas[K] extends { readOnlyBehavior: 'adapt' }
      ? never
      : K
    : never;
}[keyof AllSchemas];

/**
 * Computes the set of tool names available for a given configuration.
 *
 * - Resolves feature groups to their tool names
 * - Excludes account tools when project-scoped, except the cost tools
 *   which stay available when branching is enabled (so `create_branch`
 *   remains callable)
 * - Excludes write-only tools when read-only
 */
type AvailableToolNames<
  Feature extends FeatureGroup,
  ProjectScoped extends boolean,
  ReadOnly extends boolean,
> =
  | Exclude<
      ToolNameForFeature<Feature>,
      | (ProjectScoped extends true ? AccountToolName : never)
      | (ReadOnly extends true ? WriteToolName : never)
    >
  | (ProjectScoped extends true
      ? 'branching' extends Feature
        ? ProjectScopedCostToolName
        : never
      : never);

/**
 * Computes the tool schemas for a given configuration.
 *
 * When `ProjectScoped` is `true`, tools with `project_id` use the
 * project-scoped override (with `project_id` omitted from the input
 * schema). All other tools use their original schemas.
 */
type ToolSchemasFor<
  Feature extends FeatureGroup,
  ProjectScoped extends boolean,
  ReadOnly extends boolean,
> = Pick<
  ProjectScoped extends true
    ? Omit<AllSchemas, ProjectScopedToolName> & ProjectScopedSchemas
    : AllSchemas,
  AvailableToolNames<Feature, ProjectScoped, ReadOnly> & keyof AllSchemas
>;

/**
 * Creates a dynamically scoped tool schema map for use with AI SDK's
 * `mcpClient.tools()`.
 *
 * Mirrors the server's dynamic tool behavior:
 * - `features` controls which tool groups are included
 * - `projectScoped` omits `project_id` from input schemas and excludes
 *   account tools, except `get_cost` and `confirm_cost` which stay
 *   available when branching is enabled (matching server behavior when
 *   `projectId` is set)
 * - `readOnly` excludes mutating tools
 *
 * @example
 * ```typescript
 * import { createToolSchemas } from '@supabase/mcp-server-supabase';
 *
 * // Project-scoped with specific features
 * const schemas = createToolSchemas({
 *   features: ['database', 'docs'],
 *   projectScoped: true,
 * });
 *
 * const tools = await mcpClient.tools({ schemas });
 * ```
 */
export function createToolSchemas<
  const Features extends
    readonly FeatureGroup[] = typeof CURRENT_FEATURE_GROUPS,
  const ProjectScoped extends boolean = false,
  const ReadOnly extends boolean = false,
>(options?: {
  features?: Features;
  projectScoped?: ProjectScoped;
  readOnly?: ReadOnly;
}): ToolSchemasFor<Features[number], ProjectScoped, ReadOnly> {
  const enabledFeatures = new Set<string>(
    options?.features ?? CURRENT_FEATURE_GROUPS
  );
  const projectScoped = options?.projectScoped ?? false;
  const readOnly = options?.readOnly ?? false;

  const result: Record<string, SchemaEntry> = {};

  for (const [feature, toolNames] of Object.entries(FEATURE_TOOL_MAP)) {
    if (!enabledFeatures.has(feature)) continue;
    if (projectScoped && feature === 'account') continue;

    for (const toolName of toolNames) {
      if (readOnly && writeToolSet.has(toolName)) continue;

      if (projectScoped && toolName in PROJECT_SCOPED_OVERRIDES) {
        result[toolName] = PROJECT_SCOPED_OVERRIDES[toolName]!;
      } else {
        result[toolName] = supabaseMcpToolSchemas[toolName];
      }
    }
  }

  if (projectScoped && enabledFeatures.has('branching')) {
    for (const toolName of PROJECT_SCOPED_COST_TOOLS) {
      result[toolName] = supabaseMcpToolSchemas[toolName];
    }
  }

  return result as ToolSchemasFor<Features[number], ProjectScoped, ReadOnly>;
}
