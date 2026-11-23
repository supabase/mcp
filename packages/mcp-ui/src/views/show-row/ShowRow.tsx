import { Admonition } from '../../shared/Admonition';
import { Message } from '../../shared/Message';
import { selectRowSql, updateRowSql } from '../../shared/row-sql';
import { rowKey, type RowTable } from '../../shared/row-values';
import { RowEditor } from '../../shared/RowEditor';
import { sqlRows, type Row } from '../../shared/sql-result';
import { useMcpView } from '../../shared/use-mcp-view';

/**
 * What `show_row` sends the view in its result's `_meta` (`ShowRowViewData`
 * in mcp-server-supabase `src/tools/database-operation-tools.ts`).
 */
type ShowRowViewData = { table: RowTable; row: Row };

/**
 * View for the `show_row` tool: one row in the row editor. The tool reads the
 * row and its table; saving and refreshing go through `execute_sql`, so the
 * server's usual permissions apply, and a read-only server leaves the row
 * read-only.
 */
export function ShowRow() {
  const { toolCall, callTool, inputText } =
    useMcpView<ShowRowViewData>('supabase-show-row');

  if (toolCall.status === 'loading') return <Message>Loading row…</Message>;
  if (toolCall.status !== 'ready') {
    return (
      <Admonition
        type="warning"
        title="Failed to load row"
        description={
          toolCall.status === 'cancelled'
            ? 'Loading the row was cancelled.'
            : `Error: ${toolCall.message}`
        }
      />
    );
  }

  const { table, row } = toolCall.data;
  // Project-scoped servers drop `project_id` from tool inputs, and reject it
  // if sent, so the view passes it on only when the call had one.
  const projectId = inputText('project_id');
  const executeSql =
    callTool &&
    (async (query: string) =>
      sqlRows(
        await callTool<{ result: string }>('execute_sql', {
          ...(projectId && { project_id: projectId }),
          query,
        })
      ));
  const key = rowKey(table, row);

  return (
    <RowEditor
      table={table}
      row={row}
      onSave={
        executeSql &&
        (async (values) => {
          const [saved] = await executeSql(updateRowSql(table, key, values));
          if (!saved) {
            throw new Error(
              'No row matched its primary key. It may have been deleted.'
            );
          }
          return saved;
        })
      }
      onReload={
        executeSql &&
        (async () => {
          const [current] = await executeSql(selectRowSql(table, key));
          if (!current) throw new Error('The row no longer exists.');
          return current;
        })
      }
    />
  );
}
