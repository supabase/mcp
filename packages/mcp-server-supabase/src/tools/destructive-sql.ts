/** Adapted from supabase/supabase apps/studio (SQLEditor.constants.ts, SQLEditor.utils.ts, lib/helpers.ts), Apache-2.0. */

const sqlIdentifier = String.raw`(?:"(?:[^"]|"")+"|[a-z_\u0080-\uffff][\w$\u0080-\uffff]*)`;

// Match starts only: no candidate is allowed to rescan the remaining SQL.
const directDropColumnRegex = new RegExp(
  String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${sqlIdentifier}(?:\s*\.\s*${sqlIdentifier})?\s+drop\s+(?!constraint(?![\w$\u0080-\uffff]))(?:column\s+)?(?:if\s+exists\s+)?${sqlIdentifier}(?:\s+(?:cascade|restrict))?\s*$`,
  'i'
);
const quotedDestructiveStart =
  /['"]\s*(drop\b|delete\b|truncate\b|alter\s+table\b)/gi;
const dollarDestructiveStart =
  /execute\s+\$\w*\$\s*(drop\b|delete\b|truncate\b|alter\s+table\b)/gi;
const concatDestructiveStart = /\b(drop|delete|truncate|alter\s+table)\b/gi;

function hasDestructiveStart(sql: string, starts: RegExp): boolean {
  starts.lastIndex = 0;
  let firstAlterEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(sql)) !== null) {
    if (!/^alter/i.test(match[1]!)) {
      return true;
    }
    if (firstAlterEnd === -1) {
      firstAlterEnd = starts.lastIndex;
    }
  }
  // Only the earliest ALTER matters: every later suffix is contained in it.
  return (
    firstAlterEnd !== -1 && /\bdrop\s+column\b/i.test(sql.slice(firstAlterEnd))
  );
}

const updateWithoutWhereRegex =
  /(?:^|;)\s*update\s+(?:"(?:[^"]|"")+"|[\w]+)(?:\.(?:"(?:[^"]|"")+"|[\w]+))?\s+set\s+[\w\W]+?(?!\s*where\s)/is;

// Split SQL on semicolons that sit outside single-quoted strings and
// double-quoted identifiers. Doubled quotes (`''`, `""`) stay inside the span,
// and backslash escapes apply inside E'...' strings. Dollar-quoted bodies are
// still split, so a destructive statement inside a function body is still seen.
// An unterminated quote returns undefined so callers fall back to a plain split.
function splitOutsideQuotes(sql: string): string[] | undefined {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    if (char === "'" || char === '"') {
      const escapes =
        char === "'" &&
        i > 0 &&
        /[eE]/.test(sql[i - 1]!) &&
        !/[\w$\u0080-\uffff]/.test(sql[i - 2] ?? ' ');
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === char) {
          if (sql[i + 1] === char) {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) {
        return undefined;
      }
      continue;
    }
    if (char === ';') {
      statements.push(sql.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  statements.push(sql.slice(start));
  return statements;
}

// Statements to inspect. Real statement boundaries come from the quote-aware
// split. A statement that runs dynamic SQL (EXECUTE) is also inspected as plain
// fragments, because its string argument can itself hold several statements.
function candidateStatements(sql: string): string[] {
  const plain = sql.split(';');
  const statements = splitOutsideQuotes(sql);
  if (!statements) {
    return plain;
  }
  return statements.flatMap((statement) =>
    /execute\s/i.test(statement)
      ? [statement, ...statement.split(';')]
      : [statement]
  );
}

export function removeCommentsFromSql(sql: string): string {
  // Removing single-line comments:
  let cleanedSql = sql.replace(/--.*$/gm, '');

  // Advance past each closed block once. A missing terminator must not make
  // every subsequent /* retry the same suffix. This remains a comment heuristic,
  // not a SQL lexer (including inside string literals).
  const parts: string[] = [];
  let offset = 0;
  let start = cleanedSql.indexOf('/*', offset);
  while (start !== -1) {
    const end = cleanedSql.indexOf('*/', start + 2);
    if (end === -1) {
      break;
    }
    parts.push(cleanedSql.slice(offset, start));
    offset = end + 2;
    start = cleanedSql.indexOf('/*', offset);
  }
  if (offset !== 0) {
    parts.push(cleanedSql.slice(offset));
    cleanedSql = parts.join('');
  }

  return cleanedSql;
}

export function checkDestructiveQuery(sql: string): boolean {
  const cleanedSql = removeCommentsFromSql(sql);
  // Retain the broad explicit-column warning, but search its suffix only once.
  const alter = /(?:^|;)\s*alter\s+table\s+/i.exec(cleanedSql);
  if (
    alter &&
    /\sdrop\s+column\s/i.test(cleanedSql.slice(alter.index + alter[0].length))
  ) {
    return true;
  }

  for (const statement of candidateStatements(cleanedSql)) {
    if (
      /^\s*(drop|delete|truncate)\s/i.test(statement) ||
      directDropColumnRegex.test(statement)
    ) {
      return true;
    }
    const execute = /execute\s+/i.exec(statement);
    if (
      execute &&
      (hasDestructiveStart(
        statement.slice(execute.index + execute[0].length),
        quotedDestructiveStart
      ) ||
        hasDestructiveStart(statement, dollarDestructiveStart))
    ) {
      return true;
    }
  }

  // These original patterns allow semicolons inside their arguments. Consume
  // through the first closing parenthesis and its statement suffix, preserving
  // literal concatenation without revisiting overlapping call starts.
  const calls = /execute\s+(format|concat(?:_ws)?)\s*\([^)]*(?:\)[^;]*|$)/gi;
  let call: RegExpExecArray | null;
  while ((call = calls.exec(cleanedSql)) !== null) {
    if (
      hasDestructiveStart(
        call[0],
        call[1]!.toLowerCase() === 'format'
          ? quotedDestructiveStart
          : concatDestructiveStart
      )
    ) {
      return true;
    }
  }
  return false;
}

// Replace the contents of single-quoted string literals and double-quoted
// identifiers with empty quotes, so a downstream `where` scan can't be fooled
// by tokens like `UPDATE "where table" SET ...` or `SET name = 'where x'`.
// Postgres uses doubled quotes to escape, so `''` and `""` are matched as
// part of the same span rather than terminating it.
const stripQuotedSpans = (sql: string) =>
  sql.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:""|[^"])*"/g, '""');

export function isUpdateWithoutWhere(sql: string): boolean {
  const updateStatements = candidateStatements(sql).filter((statement) =>
    statement.trim().toLowerCase().startsWith('update')
  );
  return updateStatements.some(
    (statement) =>
      updateWithoutWhereRegex.test(statement) &&
      !/where\s/i.test(stripQuotedSpans(statement))
  );
}

export function isDestructiveSql(sql: string): boolean {
  return checkDestructiveQuery(sql) || isUpdateWithoutWhere(sql);
}
