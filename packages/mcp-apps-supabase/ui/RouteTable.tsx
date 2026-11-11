import type { ReportRoute } from '../src/schema.js';
import { millisecondFormatter, numberFormatter } from './format.js';

type Column = 'count' | 'status' | 'avg' | 'p95';

// Route strings come from request logs: they are only ever rendered as text.
export function RouteTable({
  rows,
  columns,
}: {
  rows: ReportRoute[];
  columns: Column[];
}) {
  if (rows.length === 0) {
    return <div className="placeholder">No data</div>;
  }
  const heading: Record<Column, string> = {
    count: 'Requests',
    status: 'Status',
    avg: 'Avg',
    p95: 'p95',
  };
  const cell = (row: ReportRoute, column: Column) => {
    switch (column) {
      case 'count':
        return numberFormatter(row.count);
      case 'status':
        return row.statusCode ?? '';
      case 'avg':
        return row.avgMs === null ? 'n/a' : millisecondFormatter(row.avgMs);
      case 'p95':
        return row.p95Ms === null ? 'n/a' : millisecondFormatter(row.p95Ms);
    }
  };
  return (
    <table>
      <thead>
        <tr>
          <th>Route</th>
          {columns.map((c) => (
            <th key={c} className="num">
              {heading[c]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={`${row.method} ${row.path} ${row.statusCode ?? ''} ${i}`}>
            <td className="route" title={`${row.method} ${row.path}`}>
              <span className="method">{row.method}</span>
              {row.path}
            </td>
            {columns.map((c) => (
              <td key={c} className="num">
                {cell(row, c)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
