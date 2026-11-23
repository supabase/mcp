/** A result row: column name to value, as the Management API returns it. */
export type Row = Record<string, unknown>;

/**
 * The JSON inside the untrusted-data boundary that `execute_sql` and
 * `query_logs` wrap their results in (`wrapWithUntrustedDataBoundary` in
 * mcp-server-supabase `src/tools/util.ts`). The boundary only fences the data
 * off for the model; the view reads the data within it.
 *
 * The wrapper's intro names the tag before the data opens it, so the data
 * starts at the tag's second appearance and ends at its closing tag. The tag
 * carries a random id the data can't contain.
 */
export function readUntrustedJson(text: string): unknown {
  const id = /<untrusted-data-([\w-]+)>/.exec(text)?.[1];
  const open = `<untrusted-data-${id}>`;
  const start = id && text.indexOf(open, text.indexOf(open) + open.length);
  const end = start ? text.indexOf(`</untrusted-data-${id}>`, start) : -1;
  if (!start || start < 0 || end < 0) {
    throw new Error('The result has no data.');
  }
  return JSON.parse(text.slice(start + open.length, end));
}

function toRows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error('The result has no rows.');
  return value.filter(
    (row): row is Row =>
      typeof row === 'object' && row !== null && !Array.isArray(row)
  );
}

/** Rows from an `execute_sql` result. */
export function sqlRows(result: { result: string }): Row[] {
  return toRows(readUntrustedJson(result.result));
}

/** Rows from a `query_logs` result, which wraps the logs endpoint's `{ result, error }`. */
export function logRows(result: { result: unknown }): Row[] {
  const response =
    typeof result.result === 'string'
      ? readUntrustedJson(result.result)
      : result.result;
  if (typeof response !== 'object' || response === null) {
    throw new Error('The result has no rows.');
  }
  const { result: rows, error } = response as {
    result?: unknown;
    error?: unknown;
  };
  if (error != null) {
    const message =
      typeof error === 'string'
        ? error
        : typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
          ? error.message
          : JSON.stringify(error);
    throw new Error(message);
  }
  return toRows(rows ?? []);
}

/** Column names in the order rows first use them. */
export function columnsOf(rows: readonly Row[]): string[] {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}

/** A value as one line of text: JSON for objects and arrays, `NULL` for null. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
