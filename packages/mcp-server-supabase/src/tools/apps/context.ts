import {
  dataOperations,
  type Bootstrap,
  type DataInput,
  type Table,
} from '../../apps/contracts.js';

import { ManagementApiError } from '../../management-api/index.js';
import { listTablesSql } from '../../pg-meta/index.js';
import {
  postgresTableSchema,
  type PostgresTable,
} from '../../pg-meta/types.js';
import type { Project, SupabasePlatform } from '../../platform/types.js';
import { AWS_REGION_CODES } from '../../regions.js';

export type AppToolOptions = {
  platform: SupabasePlatform;
  projectId?: string;
  readOnly?: boolean;
  accountEnabled: boolean;
  databaseEnabled: boolean;
  creationMode: 'legacy' | 'elicitation';
  debuggingEnabled?: boolean;
  /** Saved notebooks are readable when the notebooks feature is on. */
  notebooksEnabled?: boolean;
  appLinkBase?: string;
  serverVersion?: string;
};

export const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Identifiers are quoted; every user-supplied value is bound separately.
export function quoteIdentifier(value: string) {
  if (!value || value.includes('\0')) throw new Error('Invalid identifier');
  return `"${value.replaceAll('"', '""')}"`;
}

const relation = (schema: string, table: string) =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

function editableSchema(schema: string) {
  return (
    !schema.startsWith('pg_') &&
    ![
      'information_schema',
      'auth',
      'storage',
      'realtime',
      'supabase_functions',
      'supabase_migrations',
      'extensions',
      'vault',
      'graphql',
      'graphql_public',
      'net',
      'cron',
    ].includes(schema)
  );
}

export type AppContext = ReturnType<typeof createAppContext>;

/**
 * Connection policy and the reads shared by launch tools and app data tools.
 * Every app tool enforces project scope, feature selection and read-only mode
 * here; tool visibility is not authorization.
 */
export function createAppContext(options: AppToolOptions) {
  const {
    platform,
    projectId,
    readOnly,
    accountEnabled,
    databaseEnabled,
    creationMode,
  } = options;
  const database = databaseEnabled ? platform.database : undefined;
  const account = accountEnabled ? platform.account : undefined;
  const logQueries = options.debuggingEnabled
    ? platform.debugging?.queryLogs
    : undefined;
  const notebooks = options.notebooksEnabled ? platform.notebooks : undefined;
  const logsEnabled =
    !!options.debuggingEnabled &&
    !!platform.debugging?.queryLogs &&
    (platform.debugging.logsDialect ?? 'clickhouse') === 'clickhouse';

  function checkScope(id: string) {
    if (projectId && id !== projectId)
      throw new Error('Project is outside this connection’s scope');
  }
  function checkProject(id: string) {
    checkScope(id);
    if (!database) throw new Error('Database access is not enabled');
    return database;
  }
  function checkWrite(schema: string) {
    if (readOnly) throw new Error('This connection is read-only');
    if (!editableSchema(schema))
      throw new Error('Managed schemas are read-only in the table editor');
  }
  async function listTables(id: string, schema: string) {
    const db = checkProject(id);
    const query = listTablesSql([schema]);
    const rows = await db.executeSql(id, { ...query, read_only: true });
    return rows.map((row) => postgresTableSchema.parse(row));
  }
  async function getTable(id: string, schema: string, name: string) {
    const table = (await listTables(id, schema)).find(
      (t) => t.schema === schema && t.name === name
    );
    if (!table || !table.columns) throw new Error('Table is unavailable');
    return table;
  }
  function presentation(table: PostgresTable): Table {
    return {
      schema: table.schema,
      name: table.name,
      rls_enabled: table.rls_enabled,
      estimated_rows: table.live_rows_estimate,
      primary_keys: table.primary_keys.map((k) => k.name),
      editable: !readOnly && editableSchema(table.schema),
      columns: table.columns!.map((c) => ({
        name: c.name,
        data_type: c.data_type,
        format: c.format,
        nullable: c.is_nullable,
        default_value: c.default_value,
        enums: c.enums,
        editable:
          c.is_updatable &&
          !c.is_generated &&
          c.identity_generation !== 'ALWAYS',
        generated: c.is_generated || c.identity_generation === 'ALWAYS',
        identity: c.is_identity,
        foreign_key: table.relationships.find(
          (r) =>
            r.source_schema === table.schema &&
            r.source_table_name === table.name &&
            r.source_columns.includes(c.name)
        )?.target_table_name,
      })),
    };
  }
  // Preserve int8/numeric precision through JSON and JavaScript.
  function rowExpression(table: PostgresTable, alias: string) {
    const exact = table.columns!.filter((c) =>
      ['int8', 'numeric'].includes(c.format)
    );
    return `to_jsonb(${alias})${exact.map((c) => ` || jsonb_build_object(${"'" + c.name.replaceAll("'", "''") + "'"}, ${alias}.${quoteIdentifier(c.name)}::text)`).join('')}`;
  }
  function requireCompleteKey(
    table: PostgresTable,
    key: Record<string, unknown>
  ) {
    const keys = table.primary_keys.map((column) => column.name);
    if (
      !keys.length ||
      Object.keys(key).length !== keys.length ||
      keys.some((column) => !Object.hasOwn(key, column) || key[column] == null)
    )
      throw new Error('A complete primary key is required');
    return keys;
  }
  async function readTable({
    project_id,
    schema,
    table: name,
    offset,
    limit,
    sort,
    filter,
  }: DataInput<'readTable'> & { offset: number; limit: number }) {
    const table = await getTable(project_id, schema, name);
    for (const c of [sort?.column, filter?.column].filter(
      (v): v is string => v !== undefined
    )) {
      if (!table.columns!.some((col) => col.name === c))
        throw new Error('Unknown column');
    }
    const order = [
      ...new Set([
        ...(sort ? [sort.column] : []),
        ...table.primary_keys.map((k) => k.name),
      ]),
    ];
    const where = filter
      ? `where t.${quoteIdentifier(filter.column)}::text ilike $3 escape '\\'`
      : '';
    const query = `select ${rowExpression(table, 't')} as row from ${relation(schema, name)} t ${where} ${order.length ? `order by ${order.map((c) => `t.${quoteIdentifier(c)} ${sort?.column === c ? sort.direction : 'asc'} nulls last`).join(', ')}` : ''} limit $1 offset $2`;
    const parameters: unknown[] = [limit + 1, offset];
    if (filter) parameters.push(`%${filter.value.replace(/[\\%_]/g, '\\$&')}%`);
    const rows = await database!.executeSql<{ row: Record<string, unknown> }>(
      project_id,
      {
        query,
        parameters,
        read_only: true,
      }
    );
    return {
      table: presentation(table),
      rows: rows.slice(0, limit).map((r) => r.row),
      hasMore: rows.length > limit,
    };
  }
  async function readRow({
    project_id,
    schema,
    table: name,
    key,
  }: DataInput<'readRow'>) {
    const table = await getTable(project_id, schema, name);
    const keys = requireCompleteKey(table, key);
    const rel = relation(schema, name);
    const rows = await database!.executeSql<{ row: Record<string, unknown> }>(
      project_id,
      {
        query: `select ${rowExpression(table, 't')} as row from ${rel} t, jsonb_populate_record(null::${rel}, $1::jsonb) key_value where ${keys.map((column) => `t.${quoteIdentifier(column)} = key_value.${quoteIdentifier(column)}`).join(' and ')} limit 2`,
        parameters: [JSON.stringify(key)],
        read_only: true,
      }
    );
    if (rows.length !== 1)
      throw new Error('The row is no longer available. Find the row again.');
    return { table: presentation(table), row: rows[0]!.row };
  }
  async function bootstrap({
    project_ref,
    organization_slug,
  }: DataInput<'bootstrap'>): Promise<Bootstrap> {
    if (
      projectId &&
      (organization_slug || (project_ref && project_ref !== projectId))
    ) {
      throw new Error('Project is outside this connection’s scope');
    }
    const selectedProject = projectId ?? project_ref;
    const notices: string[] = [];
    type AppProject = Pick<Project, 'id' | 'name' | 'status' | 'region'> &
      Partial<Project>;
    let projects: AppProject[] = [];
    let organizations: { id: string; name: string; slug: string }[] = [];
    async function optionalRead<T>(
      operation: () => Promise<T>,
      fallback: T,
      message: string
    ): Promise<T> {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof ManagementApiError) || error.status !== 403)
          throw error;
        notices.push(message);
        return fallback;
      }
    }
    if (selectedProject) {
      // Metadata and database permissions are independent. A successful read-only
      // probe permits opening the database even without Project Settings access.
      const details = platform.account
        ? await optionalRead(
            () => platform.account!.getProject(selectedProject),
            null,
            'Project details are unavailable with this token. Showing the project reference.'
          )
        : null;
      if (details) projects = [details];
      else {
        if (!database)
          throw new Error(
            'This token cannot read project details and database access is disabled.'
          );
        await database.executeSql(selectedProject, {
          query: 'select 1 as accessible',
          read_only: true,
        });
        projects = [
          {
            id: selectedProject,
            ref: selectedProject,
            name: selectedProject,
            status: 'UNKNOWN',
            region: '',
          },
        ];
      }
    } else if (organization_slug) {
      if (!account?.listOrganizationProjects) {
        throw new Error(
          'Organization discovery is not available on this server. Open a project by reference instead.'
        );
      }
      // Do not call either account-wide list endpoint on this path.
      projects = await account.listOrganizationProjects(organization_slug);
      const org = await optionalRead(
        () => account.getOrganization(organization_slug),
        null,
        'Organization details are unavailable with this token. Showing the organization slug.'
      );
      organizations = [
        {
          id: org?.id ?? organization_slug,
          name: org?.name ?? organization_slug,
          slug: organization_slug,
        },
      ];
    } else if (account) {
      projects = await optionalRead(
        () => account.listProjects(),
        [],
        'This token cannot list projects account-wide. Open a project or organization directly.'
      );
      organizations = await optionalRead(
        () => account.listOrganizations(),
        [],
        'This token cannot list organizations account-wide. Open an organization by its slug.'
      );
    }
    return dataOperations.bootstrap.output.parse({
      server: {
        name: 'supabase',
        version: options.serverVersion ?? 'unknown',
        ...(options.appLinkBase ? { appLinkBase: options.appLinkBase } : {}),
      },
      projects,
      organizations,
      regions: AWS_REGION_CODES,
      notices,
      discovery: {
        projectRef: selectedProject ?? null,
        organizationSlug: organization_slug ?? null,
      },
      capabilities: {
        readOnly: !!readOnly,
        database: !!database,
        logQueries: !!logQueries,
        logs: logsEnabled,
        createProject:
          !!account &&
          !selectedProject &&
          !readOnly &&
          organizations.length > 0,
        creationMode,
        scopedProjectId: projectId ?? null,
        openResource: !projectId && !!(account || database),
      },
    });
  }

  return {
    ...options,
    database,
    account,
    logQueries,
    logsEnabled,
    notebooks,
    checkScope,
    checkProject,
    checkWrite,
    getTable,
    presentation,
    rowExpression,
    relation,
    requireCompleteKey,
    readTable,
    readRow,
    bootstrap,
  };
}
