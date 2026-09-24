import type { NotebookCell } from '../platform/types.js';

type LogTimeRange = Extract<NotebookCell, { type: 'log' }>['time_range'];

export type QueryCell = Extract<NotebookCell, { type: 'database' | 'log' }>;

/** Only primary database cells can execute on the current project. */
export function isPrimaryDatabaseCell(cell: QueryCell, projectId: string) {
  return (
    cell.type === 'database' &&
    (cell.database_identifier === undefined ||
      cell.database_identifier === projectId)
  );
}

export function isQueryCell(cell: NotebookCell): cell is QueryCell {
  return cell.type === 'database' || cell.type === 'log';
}

/**
 * Appends `limit <n>` to a single `select` statement that doesn't already
 * limit its rows. Anything it can't reason about safely (multiple statements,
 * comments, non-selects, or any LIMIT/FETCH token) is returned unchanged.
 */
export function applyRowLimit(sql: string, limit: number): string {
  const cleanedSql = sql.trim().replaceAll('\n', ' ').replaceAll(/\s+/g, ' ');

  const statements = [...cleanedSql.matchAll(/[a-zA-Z]*[0-9]*[;]+/g)];
  const lastSemicolon = cleanedSql.lastIndexOf(';');
  const hasMultipleStatements =
    statements.length > 1 ||
    (lastSemicolon > 0 && lastSemicolon !== cleanedSql.length - 1);

  const shouldLimit =
    limit > 0 &&
    !/--|\/\*/.test(cleanedSql) &&
    !hasMultipleStatements &&
    /^select\b/i.test(cleanedSql) &&
    // Stay conservative around subqueries and quoted text too: without a
    // parser, leaving an existing limit alone is safer than appending one.
    !/\b(?:limit|fetch)\b/i.test(cleanedSql);

  if (!shouldLimit) {
    return sql;
  }

  return `${sql.trim().replace(/;+$/, '')} limit ${limit};`;
}

/**
 * Returns the rows from a log query response, unwrapping a `{ result }`
 * envelope and throwing any error it reports.
 */
export function getLogCellRows(response: unknown): unknown {
  if (response === null || typeof response !== 'object') {
    return response;
  }

  if ('error' in response && response.error != null) {
    const error = response.error;
    let message: string | undefined;
    if (typeof error === 'string') {
      message = error;
    } else if (typeof error === 'object') {
      if ('message' in error && typeof error.message === 'string') {
        message = error.message;
      }
      if (!message && 'errors' in error && Array.isArray(error.errors)) {
        message = error.errors
          .flatMap((entry: unknown) =>
            entry !== null &&
            typeof entry === 'object' &&
            'message' in entry &&
            typeof entry.message === 'string'
              ? [entry.message]
              : []
          )
          .join('\n');
      }
    }
    // Preserve diagnostics for unfamiliar error shapes rather than returning
    // [object Object], so an agent can still use them to repair the cell.
    throw new Error(
      message || JSON.stringify(error) || 'The log query failed.'
    );
  }

  return 'result' in response ? response.result : response;
}

/** Resolves a log cell's time range to the window `queryLogs` expects. */
export function resolveLogCellWindow(range: LogTimeRange, now = new Date()) {
  if (range.type === 'absolute') {
    return { iso_timestamp_start: range.start, iso_timestamp_end: range.end };
  }

  const start = new Date(now);
  switch (range.unit) {
    case 'minute':
      start.setUTCMinutes(start.getUTCMinutes() - range.amount);
      break;
    case 'hour':
      start.setUTCHours(start.getUTCHours() - range.amount);
      break;
    case 'day':
      start.setUTCDate(start.getUTCDate() - range.amount);
      break;
    case 'week':
      start.setUTCDate(start.getUTCDate() - range.amount * 7);
      break;
    case 'month':
    case 'year': {
      // Clamp to the end of the target month, e.g. 31 Mar - 1 month = 28 Feb.
      const months = range.unit === 'year' ? range.amount * 12 : range.amount;
      const day = start.getUTCDate();
      start.setUTCDate(1);
      start.setUTCMonth(start.getUTCMonth() - months);
      const lastDay = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)
      ).getUTCDate();
      start.setUTCDate(Math.min(day, lastDay));
      break;
    }
  }

  return {
    iso_timestamp_start: start.toISOString(),
    iso_timestamp_end: now.toISOString(),
  };
}
