import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Project } from '../src/views/list-projects/ListProjects';
import type { Table } from '../src/views/list-tables/ListTables';

/**
 * Canned tool calls for the mock host. Each entry is keyed by view name and
 * provides the tool input the host sends, plus a handler that answers
 * `tools/call` requests the view makes back to the server.
 */
export type Fixture = {
  toolName: string;
  input: Record<string, unknown>;
  callTool(args: Record<string, unknown>): CallToolResult;
};

const tables = [
  {
    name: 'public.profiles',
    rls_enabled: true,
    rows: 1284,
    comment: 'User profiles',
  },
  { name: 'public.posts', rls_enabled: true, rows: 9031 },
  { name: 'public.audit_log', rls_enabled: false, rows: 52210 },
  { name: 'storage.objects', rls_enabled: true, rows: 410 },
  { name: 'auth.users', rls_enabled: true, rows: 1284 },
] satisfies Table[];

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

const projects = [
  {
    id: 'abcdefghijklmnopqrst',
    ref: 'abcdefghijklmnopqrst',
    organization_slug: 'acme',
    name: 'Acme production',
    region: 'us-east-1',
    status: 'ACTIVE_HEALTHY',
    created_at: '2025-03-14T10:00:00.000Z',
  },
  {
    id: 'bcdefghijklmnopqrstu',
    ref: 'bcdefghijklmnopqrstu',
    organization_slug: 'acme',
    name: 'Acme staging',
    region: 'eu-west-2',
    status: 'COMING_UP',
    created_at: '2026-11-10T08:30:00.000Z',
  },
  {
    id: 'cdefghijklmnopqrstuv',
    ref: 'cdefghijklmnopqrstuv',
    organization_slug: 'side-project',
    name: 'Weekend hack',
    region: 'ap-southeast-1',
    status: 'INACTIVE',
    created_at: '2024-07-02T18:45:00.000Z',
  },
  {
    id: 'defghijklmnopqrstuvw',
    ref: 'defghijklmnopqrstuvw',
    organization_slug: 'side-project',
    name: 'Restore test',
    region: 'us-west-1',
    status: 'RESTORE_FAILED',
    created_at: '2026-01-20T12:00:00.000Z',
  },
] satisfies Project[];

export const fixtures: Record<string, Fixture> = {
  'list-projects': {
    toolName: 'list_projects',
    input: {},
    callTool: () => json({ projects }),
  },
  'list-tables': {
    toolName: 'list_tables',
    input: { project_id: 'abcdefghijklmnopqrst', schemas: ['public'] },
    callTool(args) {
      const schemas = Array.isArray(args.schemas) ? args.schemas : ['public'];
      return json({
        tables: tables.filter((table) =>
          schemas.some((schema) => table.name.startsWith(`${schema}.`))
        ),
      });
    },
  },
};
