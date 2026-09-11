import type { ParseResult } from 'libpg-query';

/** Adapted from supabase/supabase apps/studio (SQLEditor.constants.ts, SQLEditor.utils.ts, lib/helpers.ts), Apache-2.0. */

const sqlIdentifier = String.raw`(?:"(?:[^"]|"")+"|[a-z_\u0080-\uffff][\w$\u0080-\uffff]*)`;

const destructiveSqlRegex = [
  // Direct destructive statements at top level or after semicolon
  /^(.*;)?\s*(drop|delete|truncate|alter\s+table\s+.*\s+drop\s+column)\s/is,
  // Single direct DROP-column action, including omitted COLUMN. ONLY target is
  // supported, not ONLY (target); do not traverse other ALTER actions.
  new RegExp(
    String.raw`(?:^|;)\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${sqlIdentifier}(?:\s*\.\s*${sqlIdentifier})?\s+drop\s+(?!constraint(?![\w$\u0080-\uffff]))(?:column\s+)?(?:if\s+exists\s+)?${sqlIdentifier}(?:\s+(?:cascade|restrict))?\s*(?:;|$)`,
    'i'
  ),
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

function removeCommentsFromSql(sql: string): string {
  // Removing single-line comments:
  let cleanedSql = sql.replace(/--.*$/gm, '');

  // Removing multi-line comments:
  cleanedSql = cleanedSql.replace(/\/\*[\s\S]*?\*\//gm, '');

  return cleanedSql;
}

function checkDestructiveQuery(sql: string): boolean {
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

function isUpdateWithoutWhere(sql: string): boolean {
  const updateStatements = sql
    .split(';')
    .filter((statement) => statement.trim().toLowerCase().startsWith('update'));
  return updateStatements.some(
    (statement) =>
      updateWithoutWhereRegex.test(statement) &&
      !/where\s/i.test(stripQuotedSpans(statement))
  );
}

function oldPredicateMatches(sql: string): boolean {
  return checkDestructiveQuery(sql) || isUpdateWithoutWhere(sql);
}

type AstObject = Record<string, unknown>;
export type SqlConfirmationReason =
  | 'destructive'
  | 'do-heuristic'
  | 'unclassified';
type ClassifiedReason = Exclude<SqlConfirmationReason, 'unclassified'>;

const dropNodeNames = [
  'DropStmt',
  'DropdbStmt',
  'DropRoleStmt',
  'DropOwnedStmt',
  'DropTableSpaceStmt',
  'DropUserMappingStmt',
  'DropSubscriptionStmt',
] as const;

class UnsupportedSqlAstError extends Error {}

function asObject(value: unknown): AstObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AstObject)
    : undefined;
}

function nodeValue(node: AstObject, key: string): AstObject | undefined {
  return asObject(node[key]);
}

function classifyCtes(statement: AstObject): ClassifiedReason | undefined {
  const ctes = asObject(statement.withClause)?.ctes;
  if (!Array.isArray(ctes)) return undefined;

  for (const cteNode of ctes) {
    const cte = nodeValue(asObject(cteNode) ?? {}, 'CommonTableExpr');
    const query = asObject(cte?.ctequery);
    if (!query) continue;

    const reason = classifyStatement(query);
    if (reason) return reason;
  }

  return undefined;
}

function parseExplainBoolean(value: unknown): boolean {
  if (value === undefined) return true;

  const argument = asObject(value);
  const integer = argument && nodeValue(argument, 'Integer');
  if (integer) {
    const numericValue = integer.ival ?? 0;
    if (numericValue === 0) return false;
    if (numericValue === 1) return true;
    throw new UnsupportedSqlAstError('invalid EXPLAIN ANALYZE integer');
  }

  const string = argument && nodeValue(argument, 'String');
  if (string && typeof string.sval === 'string') {
    switch (string.sval.toLowerCase()) {
      case 'true':
      case 'on':
        return true;
      case 'false':
      case 'off':
        return false;
      default:
        throw new UnsupportedSqlAstError('invalid EXPLAIN ANALYZE string');
    }
  }

  throw new UnsupportedSqlAstError('unsupported EXPLAIN ANALYZE value');
}

function explainExecutes(explain: AstObject): boolean {
  const options = explain.options;
  if (options === undefined) return false;
  if (!Array.isArray(options)) {
    throw new UnsupportedSqlAstError('unsupported EXPLAIN options');
  }

  let analyze = false;
  for (const optionNode of options) {
    const option = nodeValue(asObject(optionNode) ?? {}, 'DefElem');
    if (option?.defname !== 'analyze') continue;
    analyze = parseExplainBoolean(option.arg);
  }
  return analyze;
}

function classifyDo(doStatement: AstObject): ClassifiedReason | undefined {
  if (!Array.isArray(doStatement.args)) return undefined;

  for (const argumentNode of doStatement.args) {
    const argument = nodeValue(asObject(argumentNode) ?? {}, 'DefElem');
    if (argument?.defname !== 'as') continue;

    const body = argument.arg
      ? nodeValue(asObject(argument.arg) ?? {}, 'String')
      : undefined;
    const bodyText = body?.sval;
    if (typeof bodyText === 'string' && oldPredicateMatches(bodyText)) {
      return 'do-heuristic';
    }
  }

  return undefined;
}

function classifyStatement(node: AstObject): ClassifiedReason | undefined {
  if (dropNodeNames.some((name) => name in node)) return 'destructive';
  if ('DeleteStmt' in node || 'TruncateStmt' in node) return 'destructive';

  const alterTable = nodeValue(node, 'AlterTableStmt');
  if (alterTable) {
    if (
      alterTable.objtype !== 'OBJECT_TABLE' ||
      !Array.isArray(alterTable.cmds)
    ) {
      return undefined;
    }
    return alterTable.cmds.some(
      (commandNode) =>
        nodeValue(asObject(commandNode) ?? {}, 'AlterTableCmd')?.subtype ===
        'AT_DropColumn'
    )
      ? 'destructive'
      : undefined;
  }

  const update = nodeValue(node, 'UpdateStmt');
  if (update)
    return (
      classifyCtes(update) ?? (update.whereClause ? undefined : 'destructive')
    );

  const select = nodeValue(node, 'SelectStmt');
  if (select) return classifyCtes(select);

  const insert = nodeValue(node, 'InsertStmt');
  if (insert) {
    const cteReason = classifyCtes(insert);
    if (cteReason) return cteReason;

    const selectStatement = asObject(insert.selectStmt);
    return selectStatement ? classifyStatement(selectStatement) : undefined;
  }

  const explain = nodeValue(node, 'ExplainStmt');
  if (explain) {
    if (!explainExecutes(explain)) return undefined;
    const query = asObject(explain.query);
    if (!query) throw new UnsupportedSqlAstError('missing EXPLAIN query');
    return classifyStatement(query);
  }

  const doStatement = nodeValue(node, 'DoStmt');
  return doStatement ? classifyDo(doStatement) : undefined;
}

export async function getSqlConfirmationReason(
  sql: string
): Promise<SqlConfirmationReason | undefined> {
  if (sql.trim() === '') return 'unclassified';
  // Keep the WASM parser off paths where SQL confirmation is disabled or unsupported.

  const parser = await import('libpg-query');
  let parsed: ParseResult;
  try {
    parsed = await parser.parse(sql);
  } catch (error) {
    if (error instanceof parser.SqlError) return 'unclassified';
    throw error;
  }
  if (!Array.isArray(parsed.stmts)) {
    throw new Error('SQL parser returned an invalid statement list.');
  }

  try {
    for (const rawStatementValue of parsed.stmts) {
      const rawStatement = asObject(rawStatementValue);
      const statement = rawStatement && asObject(rawStatement.stmt);
      if (!statement) {
        throw new Error('SQL parser returned an invalid statement.');
      }

      const reason = classifyStatement(statement);
      if (reason) return reason;
    }
    return undefined;
  } catch (error) {
    if (error instanceof UnsupportedSqlAstError) return 'unclassified';
    throw error;
  }
}
