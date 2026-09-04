/** Adapted from supabase/supabase apps/studio (SQLEditor.constants.ts, SQLEditor.utils.ts, lib/helpers.ts), Apache-2.0. */

const destructiveSqlRegex = [
  // Direct destructive statements at top level or after semicolon
  /^(.*;)?\s*(drop|delete|truncate|alter\s+table\s+.*\s+drop\s+column)\s/is,
  // EXECUTE with string literal: EXECUTE 'DROP TABLE ...' or EXECUTE 'ALTER TABLE ... DROP COLUMN ...'
  /execute\s+(?:format\s*\([^)]*\)\s*\|\||[^;]*['"])\s*(?:(drop|delete|truncate)\b|alter\s+table[^;]*\bdrop\s+column\b)/is,
  // EXECUTE format(): EXECUTE format('DROP TABLE %I', ...)
  /execute\s+format\s*\([^)]*['"]\s*(?:(drop|delete|truncate)\b|alter\s+table[^;]*\bdrop\s+column\b)/is,
  // EXECUTE IMMEDIATE (Oracle compatibility via orafce)
  /execute\s+immediate\s+['"]\s*(?:(drop|delete|truncate)\b|alter\s+table[^;]*\bdrop\s+column\b)/is,
  // OPEN cursor FOR EXECUTE
  /open\s+\w+\s+for\s+execute\s+(?:format\s*\([^)]*\)\s*\|\||[^;]*['"])\s*(?:(drop|delete|truncate)\b|alter\s+table[^;]*\bdrop\s+column\b)/is,
  // OPEN cursor FOR EXECUTE format()
  /open\s+\w+\s+for\s+execute\s+format\s*\([^)]*['"]\s*(?:(drop|delete|truncate)\b|alter\s+table[^;]*\bdrop\s+column\b)/is,
  // RETURN QUERY EXECUTE
  /return\s+query\s+execute\s+(?:format\s*\([^)]*\)\s*\|\||[^;]*['"])\s*(?:(drop|delete|truncate)\b|alter\s+table[^;]*\bdrop\s+column\b)/is,
  // RETURN QUERY EXECUTE format()
  /return\s+query\s+execute\s+format\s*\([^)]*['"]\s*(?:(drop|delete|truncate)\b|alter\s+table[^;]*\bdrop\s+column\b)/is,
  // EXECUTE with dollar-quoted string: EXECUTE $tag$DROP TABLE$tag$
  /execute\s+\$\w*\$\s*(?:(drop|delete|truncate)\b|alter\s+table[^;]*\bdrop\s+column\b)/is,
  // EXECUTE concat() / concat_ws()
  /execute\s+concat(?:_ws)?\s*\([^)]*\b(?:(drop|delete|truncate)|alter\s+table[^)]*\bdrop\s+column\b)/i,
  // EXECUTE with E'' escape strings: EXECUTE E'DROP TABLE ...'
  /execute\s+e['"]\s*(?:(drop|delete|truncate)\b|alter\s+table[^;]*\bdrop\s+column\b)/is,
];

const updateWithoutWhereRegex =
  /(?:^|;)\s*update\s+(?:"(?:[^"]|"")+"|[\w]+)(?:\.(?:"(?:[^"]|"")+"|[\w]+))?\s+set\s+[\w\W]+?(?!\s*where\s)/is;

export function removeCommentsFromSql(sql: string): string {
  // Removing single-line comments:
  let cleanedSql = sql.replace(/--.*$/gm, '');

  // Removing multi-line comments:
  cleanedSql = cleanedSql.replace(/\/\*[\s\S]*?\*\//gm, '');

  return cleanedSql;
}

export function checkDestructiveQuery(sql: string): boolean {
  const cleanedSql = removeCommentsFromSql(sql);
  return destructiveSqlRegex.some((regex) => regex.test(cleanedSql));
}

// Replace the contents of single-quoted string literals and double-quoted
// identifiers with empty quotes, so a downstream `where` scan can't be fooled
// by tokens like `UPDATE "where table" SET ...` or `SET name = 'where x'`.
// Postgres uses doubled quotes to escape, so `''` and `""` are matched as
// part of the same span rather than terminating it.
const stripQuotedSpans = (sql: string) =>
  sql.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:""|[^"])*"/g, '""');

export function isUpdateWithoutWhere(sql: string): boolean {
  const updateStatements = sql
    .split(';')
    .filter((statement) => statement.trim().toLowerCase().startsWith('update'));
  return updateStatements.some(
    (statement) =>
      updateWithoutWhereRegex.test(statement) &&
      !/where\s/i.test(stripQuotedSpans(statement))
  );
}

export function analyzeDestructiveSql(sql: string): {
  hasDestructiveOperations: boolean;
  hasUpdateWithoutWhere: boolean;
} {
  return {
    hasDestructiveOperations: checkDestructiveQuery(sql),
    hasUpdateWithoutWhere: isUpdateWithoutWhere(sql),
  };
}

export function isDestructiveSql(sql: string): boolean {
  const analysis = analyzeDestructiveSql(sql);
  return analysis.hasDestructiveOperations || analysis.hasUpdateWithoutWhere;
}
