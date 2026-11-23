import './results-grid.css';

import { columnsOf, displayValue, type Row } from './sql-result';

/** How a cell's value is styled: NULL faded, numbers aligned right. */
function cellType(value: unknown) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

/**
 * Query results as a compact, read-first grid, the QueryResultsGrid of the
 * Supabase surfaces: monospace cells, a sticky header, row numbers in a
 * sticky first column, and long values cut to one line with the whole value
 * on hover. Its container scrolls it.
 */
export function ResultsGrid({ rows }: { rows: readonly Row[] }) {
  const columns = columnsOf(rows);
  return (
    <table className="results-grid" aria-label="Query results">
      <thead>
        <tr>
          <th data-slot="row-number" aria-label="Row number">
            #
          </th>
          {columns.map((column) => (
            <th scope="col" key={column}>
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          // Rows have no identity of their own; they never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <tr key={index}>
            <td data-slot="row-number">{index + 1}</td>
            {columns.map((column) => {
              const text = displayValue(row[column]);
              return (
                <td key={column} data-type={cellType(row[column])} title={text}>
                  {text}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
