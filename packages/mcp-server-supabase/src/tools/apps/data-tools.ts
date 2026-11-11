import type { Annotations, Tool } from '@supabase/mcp-utils';
import {
  dataOperations,
  type DataInput,
  type DataOperationName,
  type DataOperations,
} from '../../apps/contracts.js';
import type { z } from 'zod/v4';

import { readProjectOverview } from './project-overview.js';
import { parseLogQueryRows } from './log-rows.js';
import {
  quoteIdentifier,
  readAnnotations,
  type AppContext,
} from './context.js';

// Follows Studio's unified logs. Gateway, auth and storage rows report
// severity_text INFO whatever their response, so HTTP status decides first and
// severity applies only to rows without one. Expressions are inlined because
// the logs endpoint cannot filter on derived aliases.
const httpStatusSql =
  "CASE WHEN source = 'auth_logs' THEN log_attributes['status'] WHEN source = 'storage_logs' THEN log_attributes['res.statusCode'] ELSE log_attributes['response.status_code'] END";
const logLevelSql = `CASE WHEN toInt32OrZero(${httpStatusSql}) >= 500 THEN 'error' WHEN toInt32OrZero(${httpStatusSql}) BETWEEN 400 AND 499 THEN 'warning' WHEN toInt32OrZero(${httpStatusSql}) BETWEEN 200 AND 299 THEN 'info' WHEN upper(severity_text) IN ('ERROR', 'FATAL', 'PANIC', 'CRITICAL', 'ALERT', 'EMERGENCY') THEN 'error' WHEN upper(severity_text) IN ('WARNING', 'WARN') THEN 'warning' ELSE 'info' END`;
const logColumnsSql = `timestamp, source, severity_text, (${logLevelSql}) AS level, (CASE WHEN source = 'postgres_logs' THEN log_attributes['parsed.sql_state_code'] ELSE ${httpStatusSql} END) AS status, if(source = 'storage_logs', log_attributes['req.method'], log_attributes['request.method']) AS method, if(source = 'storage_logs', log_attributes['req.url'], log_attributes['request.path']) AS path, event_message`;

const mutationAnnotations = {
  ...readAnnotations,
  readOnlyHint: false,
  idempotentHint: false,
};

type Input<K extends DataOperationName> = z.output<DataOperations[K]['input']>;
type Output<K extends DataOperationName> = z.input<DataOperations[K]['output']>;

/**
 * Registers one data operation from the shared contract: its tool name,
 * description and argument schema come from `dataOperations`, and the result
 * is validated against the operation's output schema before it is returned.
 */
function dataTool<K extends DataOperationName>(
  name: K,
  options: {
    annotations: Annotations;
    hidden?: boolean;
    execute(input: Input<K>): Promise<Output<K>>;
  }
): [string, Tool] {
  const operation = dataOperations[name];
  return [
    operation.tool,
    {
      description: operation.description,
      parameters: operation.input as unknown as z.ZodObject<any>,
      outputSchema: operation.output as unknown as z.ZodObject<any>,
      annotations: options.annotations,
      hidden: options.hidden,
      _meta: {
        ui: {
          visibility:
            operation.visibility === 'app' ? ['app'] : ['model', 'app'],
        },
      },
      async execute(input) {
        const result = operation.output.parse(
          await options.execute(input as Input<K>)
        ) as Record<string, unknown>;
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    },
  ];
}

/** App-only tools a mounted surface calls for its data. Hidden from the model. */
export function getDataTools(app: AppContext): Record<string, Tool> {
  const { platform, database, readOnly } = app;
  const tools: [string, Tool][] = [
    dataTool('getProjectOverview', {
      annotations: readAnnotations,
      async execute({ project_id }) {
        app.checkScope(project_id);
        return readProjectOverview(
          project_id,
          app.debuggingEnabled ? platform.debugging : undefined
        );
      },
    }),
  ];

  if (app.logsEnabled)
    tools.push(
      dataTool('getLogs', {
        annotations: readAnnotations,
        async execute({ project_id, minutes, source, level }) {
          app.checkScope(project_id);
          const end = new Date();
          const start = new Date(end.getTime() - minutes * 60000);
          const where = [
            source === 'all'
              ? ''
              : source === 'edge_functions'
                ? "source IN ('function_edge_logs', 'function_logs')"
                : `source = '${source}'`,
            level === 'all' ? '' : `(${logLevelSql}) = '${level}'`,
          ].filter(Boolean);
          const result = await platform.debugging!.queryLogs!(project_id, {
            sql: `SELECT ${logColumnsSql} FROM logs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY timestamp DESC LIMIT 100`,
            iso_timestamp_start: start.toISOString(),
            iso_timestamp_end: end.toISOString(),
          });
          return {
            rows: parseLogQueryRows(result),
            start: start.toISOString(),
            end: end.toISOString(),
          };
        },
      })
    );

  if (database)
    tools.push(
      dataTool('readRow', {
        annotations: readAnnotations,
        execute: (input) => app.readRow(input),
      }),
      dataTool('listSchemas', {
        annotations: readAnnotations,
        async execute({ project_id }) {
          const db = app.checkProject(project_id);
          const schemas = await db.executeSql<{ name: string }>(project_id, {
            query:
              "select nspname as name from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by (nspname = 'public') desc, nspname",
            read_only: true,
          });
          return { schemas };
        },
      }),
      dataTool('listTables', {
        annotations: readAnnotations,
        async execute({ project_id, schema }) {
          const tables = await app.listTables(project_id, schema);
          return {
            tables: tables
              .filter((table) => table.schema === schema)
              .map((table) => ({
                name: table.name,
                rows: table.live_rows_estimate,
                rls_enabled: table.rls_enabled,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          };
        },
      }),
      dataTool('readTable', {
        annotations: readAnnotations,
        execute: (input) => app.readTable(input),
      }),
      // Still registered in read-only mode so direct calls are rejected by policy.
      dataTool('updateRow', {
        annotations: { ...mutationAnnotations, destructiveHint: true },
        hidden: !!readOnly,
        execute: updateRow,
      }),
      dataTool('insertRow', {
        annotations: mutationAnnotations,
        hidden: !!readOnly,
        execute: insertRow,
      })
    );

  async function updateRow({
    project_id,
    schema,
    table: name,
    key,
    values,
    previous,
  }: DataInput<'updateRow'>) {
    app.checkWrite(schema);
    const table = await app.getTable(project_id, schema, name);
    const keys = app.requireCompleteKey(table, key);
    const names = Object.keys(values);
    if (!names.length) throw new Error('No changes to save');
    if (
      Object.keys(previous).length !== names.length ||
      names.some((column) => !Object.hasOwn(previous, column))
    )
      throw new Error('Previous values are required for every changed column');
    for (const column of names) {
      const col = table.columns!.find((c) => c.name === column);
      if (
        !col ||
        !col.is_updatable ||
        col.is_generated ||
        col.is_identity ||
        keys.includes(column)
      )
        throw new Error('This column cannot be edited');
    }
    const rel = app.relation(schema, name);
    const query = `update ${rel} t set ${names.map((column) => `${quoteIdentifier(column)} = new_value.${quoteIdentifier(column)}`).join(', ')} from jsonb_populate_record(null::${rel}, $1::jsonb) key_value, jsonb_populate_record(null::${rel}, $2::jsonb) new_value, jsonb_populate_record(null::${rel}, $3::jsonb) old_value where ${keys.map((k) => `t.${quoteIdentifier(k)} = key_value.${quoteIdentifier(k)}`).join(' and ')} and ${names.map((column) => `to_jsonb(t.${quoteIdentifier(column)}) is not distinct from to_jsonb(old_value.${quoteIdentifier(column)})`).join(' and ')} returning ${app.rowExpression(table, 't')} as row`;
    const rows = await database!.executeSql<{ row: Record<string, unknown> }>(
      project_id,
      {
        query,
        parameters: [
          JSON.stringify(key),
          JSON.stringify(values),
          JSON.stringify(previous),
        ],
        read_only: false,
      }
    );
    if (rows.length !== 1)
      throw new Error(
        'The row changed or is no longer available. Refresh before editing again.'
      );
    return { rows };
  }

  async function insertRow({
    project_id,
    schema,
    table: name,
    values,
  }: DataInput<'insertRow'>) {
    app.checkWrite(schema);
    const table = await app.getTable(project_id, schema, name);
    const names = Object.keys(values);
    for (const column of names) {
      const c = table.columns!.find((c) => c.name === column);
      if (
        !c ||
        c.is_generated ||
        c.identity_generation === 'ALWAYS' ||
        !c.is_updatable
      )
        throw new Error(`Cannot insert column ${column}`);
    }
    const rel = app.relation(schema, name);
    const insert = names.length
      ? `(${names.map(quoteIdentifier).join(', ')}) select ${names.map(quoteIdentifier).join(', ')} from jsonb_populate_record(null::${rel}, $1::jsonb)`
      : 'default values';
    const rows = await database!.executeSql<{ row: Record<string, unknown> }>(
      project_id,
      {
        query: `insert into ${rel} as t ${insert} returning ${app.rowExpression(table, 't')} as row`,
        parameters: names.length ? [JSON.stringify(values)] : [],
        read_only: false,
      }
    );
    return { rows };
  }

  return Object.fromEntries(tools);
}
