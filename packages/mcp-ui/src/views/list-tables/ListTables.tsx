import { Message } from '../../shared/Message';
import { useToolResult } from '../../shared/use-tool-result';

export type Table = {
  name: string;
  rls_enabled: boolean;
  rows: number | null;
  comment?: string | null;
};

/** View for the `list_tables` tool. */
export function ListTables() {
  const state = useToolResult<{ tables: Table[] }>('supabase-list-tables');

  if (state.status === 'error') {
    return <Message tone="error">{state.message}</Message>;
  }
  if (state.status === 'cancelled') {
    return (
      <Message>Cancelled{state.reason ? ` (${state.reason})` : ''}.</Message>
    );
  }
  if (state.status === 'loading') return <Message>Loading tables…</Message>;
  if (state.data.tables.length === 0) {
    return <Message>No tables found.</Message>;
  }

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th className="heading-meta">Name</th>
            <th className="heading-meta">RLS</th>
            <th className="heading-meta numeric">Rows</th>
          </tr>
        </thead>
        <tbody>
          {state.data.tables.map((table) => {
            const [schema, name] = splitName(table.name);
            return (
              <tr key={table.name}>
                <td>
                  <div>
                    <span className="text-lighter">{schema}.</span>
                    {name}
                  </div>
                  {table.comment && (
                    <div className="text-lighter" style={{ fontSize: 12 }}>
                      {table.comment}
                    </div>
                  )}
                </td>
                <td>
                  {table.rls_enabled ? (
                    <span className="badge badge-success">Enabled</span>
                  ) : (
                    <span className="badge badge-destructive">Disabled</span>
                  )}
                </td>
                <td className="numeric text-muted">
                  {table.rows?.toLocaleString() ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** `public.profiles` → `['public', 'profiles']`. */
function splitName(qualified: string): [string, string] {
  const dot = qualified.indexOf('.');
  return dot === -1
    ? ['public', qualified]
    : [qualified.slice(0, dot), qualified.slice(dot + 1)];
}
